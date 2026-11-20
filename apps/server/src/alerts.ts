// Alert engine: after every successful chain refresh, compare each watch against the new loan state.
// Pure core (`evaluate`) + an effectful runner that sends via Telegram and persists bands.
import { PARYON_APP_URL, type LoanView, type RiskBand } from "@redline/api-types";
import { riskBand } from "@redline/paryon-decoder";
import type { Db, StoredBand, WatchRow } from "./db.js";
import type { LoanState } from "./reader.js";

export const MAX_ALERTS_PER_CYCLE = 20;
/** a band is left (toward safe) only after the distance recovers this far past its threshold */
export const HYSTERESIS = 0.03;
const EPS = 1e-9;

export type AlertRule = "liquidation" | "loan_gone";

export interface Alert {
  watchId: string;
  accountId: string;
  loanId: string;
  rule: AlertRule;
  /** the band entered, or "gone" */
  value: StoredBand;
  text: string;
}

export interface BandUpdate {
  watchId: string;
  lastBand: StoredBand | null;
}

const RANK: Record<RiskBand, number> = { safe: 0, watch: 1, danger: 2, critical: 3 };
const SEVERITY: Record<StoredBand, number> = { ...RANK, gone: 2.5 };

/** riskBand with every threshold raised by HYSTERESIS: the band you are still "in" while recovering */
function stickyBand(distance: number | null): RiskBand {
  if (distance === null) return "safe";
  return riskBand(distance - HYSTERESIS + EPS);
}

/** the band to store, given the last stored band and the current distance */
export function nextBand(last: RiskBand, distance: number | null): RiskBand {
  const raw = riskBand(distance);
  if (RANK[raw] >= RANK[last]) return raw;
  // improving: move back toward safe only as far as hysteresis allows, never past the raw band
  const sticky = stickyBand(distance);
  return RANK[sticky] < RANK[last] ? sticky : last;
}

const short = (id: string) => id.slice(0, 8);
const pct = (x: number | null, digits = 1) => (x === null ? "n/a" : `${x.toFixed(digits)}%`);
const usd = (x: number | null) => (x === null ? "n/a" : `$${x.toFixed(2)}`);
const ICON: Record<RiskBand, string> = { safe: "🟢", watch: "🟡", danger: "🟠", critical: "🔴" };

export function loanLines(loan: LoanView, priceUsd: number): string[] {
  return [
    `Collateral ratio: ${pct(loan.collateralRatioPct)}`,
    `Distance to liquidation: ${pct(loan.distanceToLiquidation === null ? null : loan.distanceToLiquidation * 100)}`,
    `Liquidation price: ${usd(loan.liquidationPriceUsd)} (BCH now ${usd(priceUsd)})`,
  ];
}

function liquidationText(loan: LoanView, band: RiskBand, priceUsd: number): string {
  const head =
    band === "critical"
      ? "is CRITICAL: liquidation is close"
      : band === "danger"
        ? "is in DANGER of liquidation"
        : "entered the WATCH band";
  return [
    `${ICON[band]} Redline: your loan ${short(loan.id)} ${head}.`,
    "",
    ...loanLines(loan, priceUsd),
    "",
    `Add collateral or repay in the Paryon app: ${loan.paryonUrl || PARYON_APP_URL}`,
  ]
    .join("\n")
    .slice(0, 1000);
}

const goneText = (loanId: string) =>
  `⚫ Redline: your watched loan ${short(loanId)} is gone — it was closed, fully repaid, or liquidated. Check the Paryon app: ${PARYON_APP_URL}`;

/** a loan must be absent from this many consecutive successful refreshes before it counts as gone */
export const GONE_AFTER_MISSES = 2;

/**
 * `missing`: loan id → consecutive successful refreshes (including `next`) the loan has been absent from.
 * Gone is decided from that count and the watch's persisted band, never from `prev`, so a restart (which
 * resets the counts) can never fire "gone" on its first snapshot. `prev` is kept for the listener shape.
 */
export function evaluate(
  watches: readonly WatchRow[],
  _prev: LoanState | null,
  next: LoanState,
  now: number,
  missing: ReadonlyMap<string, number> = new Map(),
): { alerts: Alert[]; bandUpdates: BandUpdate[] } {
  const alerts: Alert[] = [];
  const bandUpdates: BandUpdate[] = [];
  for (const w of watches) {
    const muted = w.mutedUntil !== null && w.mutedUntil > now;
    const alert = (rule: AlertRule, value: StoredBand, text: string) => {
      if (!muted) alerts.push({ watchId: w.id, accountId: w.accountId, loanId: w.loanId, rule, value, text });
    };
    const setBand = (band: StoredBand | null) => {
      if (band !== w.lastBand) bandUpdates.push({ watchId: w.id, lastBand: band });
    };

    const loan = next.byId.get(w.loanId);
    if (!loan) {
      // gone = we had evaluated it (band known, not already gone) and it has been missing long enough
      const known = w.lastBand !== null && w.lastBand !== "gone";
      if (known && (missing.get(w.loanId) ?? 0) >= GONE_AFTER_MISSES) {
        if (w.rules.loanGone) alert("loan_gone", "gone", goneText(w.loanId));
        setBand("gone");
      }
      continue;
    }

    const current = riskBand(loan.distanceToLiquidation);
    if (w.lastBand === null || w.lastBand === "gone") {
      // first evaluation (or the loan came back): record silently unless already risky
      if (w.rules.liquidation && RANK[current] >= RANK.danger) alert("liquidation", current, liquidationText(loan, current, next.priceUsd));
      setBand(current);
      continue;
    }
    const band = nextBand(w.lastBand, loan.distanceToLiquidation);
    if (RANK[band] > RANK[w.lastBand] && w.rules.liquidation) {
      alert("liquidation", band, liquidationText(loan, band, next.priceUsd));
    }
    setBand(band);
  }
  return { alerts, bandUpdates };
}

/** grammY: GrammyError.error_code / description; undefined for network errors */
const telegramCode = (e: unknown): number | undefined => {
  const c = typeof e === "object" && e !== null ? (e as { error_code?: unknown }).error_code : undefined;
  return typeof c === "number" ? c : undefined;
};
/** the chat is gone for good: 403 (bot blocked / removed) or 400 "chat not found" */
const isChatGone = (e: unknown): boolean => {
  const code = telegramCode(e);
  if (code === 403) return true;
  const text = `${(e as { description?: unknown })?.description ?? ""} ${e instanceof Error ? e.message : ""}`;
  return code === 400 && /chat not found/i.test(text);
};
/** any other 4xx except 429 will fail the same way again: do not retry */
const isPermanent = (e: unknown): boolean => {
  const code = telegramCode(e);
  return code !== undefined && code >= 400 && code < 500 && code !== 429;
};

export interface AlertRunnerDeps {
  db: Pick<Db, "allWatches" | "getTelegramChat" | "setWatchBand" | "recordAlert" | "unlinkTelegram">;
  sendMessage: (chatId: string, text: string) => Promise<void>;
  /** unix seconds */
  now?: () => number;
  log?: (msg: string) => void;
  maxPerCycle?: number;
}

export function createAlertRunner(deps: AlertRunnerDeps) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const log = deps.log ?? ((m: string) => console.log(m));
  const cap = deps.maxPerCycle ?? MAX_ALERTS_PER_CYCLE;
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let queue: Promise<void> = Promise.resolve();
  /** loan id → consecutive successful refreshes it was absent from (in memory: a restart resets it) */
  const missing = new Map<string, number>();

  async function run(prev: LoanState | null, next: LoanState): Promise<void> {
    const t = now();
    const { db } = deps;
    const watches = db.allWatches();
    const watched = new Set(watches.map((w) => w.loanId));
    for (const id of missing.keys()) if (!watched.has(id) || next.byId.has(id)) missing.delete(id);
    for (const id of watched) if (!next.byId.has(id)) missing.set(id, (missing.get(id) ?? 0) + 1);

    const { alerts, bandUpdates } = evaluate(watches, prev, next, t, missing);
    const updates = new Map(bandUpdates.map((u) => [u.watchId, u.lastBand]));
    // watches without an alert: save their band now
    const alerting = new Set(alerts.map((a) => a.watchId));
    for (const [watchId, band] of updates) if (!alerting.has(watchId)) db.setWatchBand(watchId, band);
    /** save this watch's new band right away (so a crash mid-cycle cannot resend it) */
    const advance = (watchId: string) => {
      if (updates.has(watchId)) db.setWatchBand(watchId, updates.get(watchId) ?? null);
    };

    // most severe first, so a capped cycle drops the least urgent
    const ordered = [...alerts].sort((a, b) => SEVERITY[b.value] - SEVERITY[a.value]);
    let sent = 0;
    let capped = 0;
    for (const a of ordered) {
      const chat = db.getTelegramChat(a.accountId);
      if (!chat || (chat.mutedUntil !== null && chat.mutedUntil > t)) {
        advance(a.watchId); // suppressed; band still advances so there is no burst later
        continue;
      }
      if (sent >= cap) {
        capped++; // keep the old band so it alerts next cycle
        continue;
      }
      sent++;
      try {
        await deps.sendMessage(chat.chatId, a.text);
        db.recordAlert(a.watchId, a.rule, a.value, t);
        advance(a.watchId);
      } catch (e) {
        if (isChatGone(e)) {
          // blocked or kicked: stop trying this chat
          db.unlinkTelegram(a.accountId);
          advance(a.watchId);
          log(`telegram chat for account ${a.accountId.slice(0, 8)} unlinked (${errMsg(e)})`);
        } else if (isPermanent(e)) {
          // e.g. 400 message rejected: retrying would fail forever, so drop this alert
          advance(a.watchId);
          log(`telegram send failed permanently (watch ${a.watchId}), dropped: ${errMsg(e)}`);
        } else {
          // transient: keep the old band so the alert is retried next refresh
          log(`telegram send failed (watch ${a.watchId}), will retry: ${errMsg(e)}`);
        }
      }
    }
    if (capped > 0) log(`alerts capped at ${cap} this cycle; ${capped} deferred to the next refresh`);
  }

  return {
    /** register with reader.onUpdate; never rejects. Cycles run one at a time. */
    onUpdate(prev: LoanState | null, next: LoanState): Promise<void> {
      const p = queue.then(() => run(prev, next)).catch((e: unknown) => log(`alert cycle failed: ${errMsg(e)}`));
      queue = p;
      return p;
    },
  };
}
