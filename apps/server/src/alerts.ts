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

export function evaluate(
  watches: readonly WatchRow[],
  prev: LoanState | null,
  next: LoanState,
  now: number,
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
      // gone = it was there last refresh, or (after a restart) we had evaluated it before
      const wasThere = prev ? prev.byId.has(w.loanId) : w.lastBand !== null;
      if (w.lastBand !== "gone" && wasThere) {
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

export interface AlertRunnerDeps {
  db: Pick<Db, "allWatches" | "getTelegramChat" | "setWatchBand" | "recordAlert">;
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

  async function run(prev: LoanState | null, next: LoanState): Promise<void> {
    const t = now();
    const { db } = deps;
    const { alerts, bandUpdates } = evaluate(db.allWatches(), prev, next, t);
    const updates = new Map(bandUpdates.map((u) => [u.watchId, u.lastBand]));
    // most severe first, so a capped cycle drops the least urgent
    const ordered = [...alerts].sort((a, b) => SEVERITY[b.value] - SEVERITY[a.value]);
    let sent = 0;
    let capped = 0;
    for (const a of ordered) {
      const chat = db.getTelegramChat(a.accountId);
      if (!chat || (chat.mutedUntil !== null && chat.mutedUntil > t)) continue; // suppressed; band still advances
      if (sent >= cap) {
        capped++;
        updates.delete(a.watchId); // keep the old band so it alerts next cycle
        continue;
      }
      sent++;
      try {
        await deps.sendMessage(chat.chatId, a.text);
        db.recordAlert(a.watchId, a.rule, a.value, t);
      } catch (e) {
        log(`telegram send failed (watch ${a.watchId}): ${errMsg(e)}`);
      }
    }
    if (capped > 0) log(`alerts capped at ${cap} this cycle; ${capped} deferred to the next refresh`);
    for (const [watchId, band] of updates) db.setWatchBand(watchId, band);
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
