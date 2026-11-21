// Alert engine: after every successful chain refresh, compare each watch with the new loan state.
// Pure core (`evaluate`) plus a runner that reserves, sends and records alerts (docs/SECURITY.md
// "Data integrity of the alarm", PRD R2 and R6).
import { randomBytes } from "node:crypto";
import { PARYON_APP_URL, type LoanView, type RiskBand } from "@redline/api-types";
import { riskBand } from "@redline/paryon-decoder";
import type { Db } from "./db/open.js";
import { allWatches, setWatchState, type WatchBand, type WatchRow } from "./db/watches.js";
import type { LoanState } from "./reader.js";

export const MAX_ALERTS_PER_CYCLE = 20;
/** a band is left (toward safe) only after the distance recovers this far past its threshold */
export const HYSTERESIS = 0.03;
/** a loan counts as gone after this many consecutive successful reads without it (PRD R2) */
export const GONE_AFTER_MISSES = 3;
/** alerts are never sent from data older than this */
export const STALE_MS = 5 * 60_000;
const EPS = 1e-9;

export type AlertRule = "liquidation" | "loan_gone";

export interface Alert {
  watchId: string;
  accountId: string;
  loanId: string;
  rule: AlertRule;
  /** the band entered, or "gone" */
  band: WatchBand;
  /** distance to liquidation (0..1) when the alert was decided; null for "gone" */
  value: number | null;
  text: string;
}

/** What a watch should look like after this refresh, and the alert to send if any. */
export interface Outcome {
  watch: WatchRow;
  lastBand: WatchBand | null;
  missedReads: number;
  alert: Alert | null;
}

const RANK: Record<RiskBand, number> = { safe: 0, watch: 1, danger: 2, critical: 3 };
const SEVERITY: Record<WatchBand, number> = { ...RANK, gone: 2.5 };

/** riskBand with every threshold raised by HYSTERESIS: the band you are still "in" while recovering */
function stickyBand(distance: number | null): RiskBand {
  if (distance === null) return "safe";
  return riskBand(distance - HYSTERESIS + EPS);
}

/** the band to store, given the last stored band and the current distance */
export function nextBand(last: RiskBand, distance: number | null): RiskBand {
  const raw = riskBand(distance);
  if (RANK[raw] >= RANK[last]) return raw;
  const sticky = stickyBand(distance);
  return RANK[sticky] < RANK[last] ? sticky : last;
}

const short = (id: string) => id.slice(0, 8);
const usd = (x: number) => `$${x.toFixed(2)}`;
const pctOf = (x: number) => `${Math.max(0, Math.round(x * 100))}%`;

/** BRAND.md voice: plain, specific, calm; numbers over adjectives; no emojis. */
export function liquidationText(loan: LoanView, priceUsd: number): string {
  const d = loan.distanceToLiquidation ?? 0;
  const liq = loan.liquidationPriceUsd ?? 0;
  return [
    `Redline: your loan ${short(loan.id)} is ${pctOf(d)} from liquidation.`,
    `BCH at ${usd(liq)} or below loses the collateral. BCH is ${usd(priceUsd)} now.`,
    `Collateral ratio ${loan.collateralRatioPct === null ? "n/a" : `${loan.collateralRatioPct.toFixed(1)}%`}.`,
    `Add collateral or repay in the Paryon app: ${loan.paryonUrl || PARYON_APP_URL}`,
  ].join("\n");
}

export const goneText = (loanId: string) =>
  [
    `Redline: your watched loan ${short(loanId)} is no longer open.`,
    "It was repaid, closed or liquidated. Check it in the Paryon app: " + PARYON_APP_URL,
  ].join("\n");

/**
 * Pure: decides each watch's new band, miss count and alert. `muted(accountId)` suppresses the
 * message but the band still moves, so a muted account does not get a burst later.
 */
export function evaluate(watches: readonly WatchRow[], next: LoanState, muted: (accountId: string) => boolean): Outcome[] {
  return watches.map((w) => {
    const make = (lastBand: WatchBand | null, missedReads: number, alert: Omit<Alert, "watchId" | "accountId" | "loanId"> | null): Outcome => ({
      watch: w,
      lastBand,
      missedReads,
      alert: alert && !muted(w.accountId) ? { watchId: w.id, accountId: w.accountId, loanId: w.loanId, ...alert } : null,
    });

    const loan = next.byId.get(w.loanId);
    if (!loan) {
      const misses = w.missedReads + 1;
      const known = w.lastBand !== null && w.lastBand !== "gone";
      if (known && misses >= GONE_AFTER_MISSES) {
        return make("gone", misses, w.rules.loanGone ? { rule: "loan_gone", band: "gone", value: null, text: goneText(w.loanId) } : null);
      }
      return make(w.lastBand, misses, null);
    }

    const current = riskBand(loan.distanceToLiquidation);
    const alertFor = (band: RiskBand) =>
      w.rules.liquidation ? { rule: "liquidation" as const, band, value: loan.distanceToLiquidation, text: liquidationText(loan, next.priceUsd) } : null;
    if (w.lastBand === null || w.lastBand === "gone") {
      // first evaluation, or the loan came back: record silently unless it is already risky
      return make(current, 0, RANK[current] >= RANK.danger ? alertFor(current) : null);
    }
    const band = nextBand(w.lastBand, loan.distanceToLiquidation);
    return make(band, 0, RANK[band] > RANK[w.lastBand] ? alertFor(band) : null);
  });
}

/** grammY puts the Bot API status on GrammyError.error_code; undefined for network errors */
const telegramCode = (e: unknown): number | undefined => {
  const c = typeof e === "object" && e !== null ? (e as { error_code?: unknown }).error_code : undefined;
  return typeof c === "number" ? c : undefined;
};
const telegramText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** the chat is gone for good: blocked (403) or "chat not found" (400) */
const chatGone = (e: unknown) => {
  const code = telegramCode(e);
  return code === 403 || (code === 400 && /chat not found/i.test(telegramText(e)));
};
/** worth retrying next refresh: rate limit, server error, network, or our own token rejected (401) */
const transient = (e: unknown) => {
  const code = telegramCode(e);
  return code === undefined || code === 401 || code === 429 || code >= 500;
};

export interface AlertDeps {
  db: Db;
  sendMessage(chatId: string, text: string): Promise<void>;
  now?: () => Date;
  log?: (m: string) => void;
}

/**
 * Runs `evaluate` on every reader update and delivers the alerts. Cycles never overlap. Each alert
 * is reserved first (alerts_sent row with its unique watch/rule/band/arming key, plus the watch's
 * new band, in one transaction), then sent. A transient send failure undoes the reservation so the
 * next refresh tries again; a closed chat is unlinked.
 */
export function createAlertRunner(deps: AlertDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.log(m));
  let queue: Promise<void> = Promise.resolve();

  const chatOf = (accountId: string): string | null =>
    (db.prepare("SELECT chat_id FROM telegram_chats WHERE account_id = ?").get(accountId) as { chat_id: string } | undefined)?.chat_id ?? null;
  const isMuted = (accountId: string): boolean =>
    (db.prepare("SELECT muted FROM accounts WHERE id = ?").get(accountId) as { muted: number } | undefined)?.muted === 1;

  /** reserve an alert; null when this exact alert was already recorded (unique key) */
  const reserve = (o: Outcome, a: Alert): string | null => {
    const id = randomBytes(16).toString("hex");
    db.exec("BEGIN IMMEDIATE");
    try {
      const prior = (
        db.prepare("SELECT count(*) AS n FROM alerts_sent WHERE watch_id = ? AND rule = ? AND band = ?").get(a.watchId, a.rule, a.band) as { n: number }
      ).n;
      db.prepare("INSERT INTO alerts_sent (id, watch_id, rule, band, arming, value, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        id, a.watchId, a.rule, a.band, prior + 1, a.value, Math.floor(now().getTime() / 1000),
      );
      setWatchState(db, o.watch.id, o.lastBand, o.missedReads);
      db.exec("COMMIT");
      return id;
    } catch (e) {
      db.exec("ROLLBACK");
      if (e instanceof Error && /UNIQUE/i.test(e.message)) return null;
      throw e;
    }
  };
  const release = (o: Outcome, reservationId: string) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM alerts_sent WHERE id = ?").run(reservationId);
      setWatchState(db, o.watch.id, o.watch.lastBand, o.watch.missedReads);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  async function cycle(next: LoanState): Promise<void> {
    if (now().getTime() - new Date(next.updatedAt).getTime() > STALE_MS) {
      log("alerts skipped: chain data is stale");
      return;
    }
    const outcomes = evaluate(allWatches(db), next, isMuted);
    const toSend: Array<{ o: Outcome; a: Alert; chatId: string }> = [];
    for (const o of outcomes) {
      const changed = o.lastBand !== o.watch.lastBand || o.missedReads !== o.watch.missedReads;
      const chatId = o.alert ? chatOf(o.alert.accountId) : null;
      if (o.alert && chatId) toSend.push({ o, a: o.alert, chatId });
      else if (changed) setWatchState(db, o.watch.id, o.lastBand, o.missedReads); // unlinked or muted: band still moves
    }
    toSend.sort((x, y) => SEVERITY[y.a.band] - SEVERITY[x.a.band]);
    if (toSend.length > MAX_ALERTS_PER_CYCLE) {
      log(`alerts capped: sending ${MAX_ALERTS_PER_CYCLE} of ${toSend.length}; the rest go next refresh`);
    }
    for (const { o, a, chatId } of toSend.slice(0, MAX_ALERTS_PER_CYCLE)) {
      const reservation = reserve(o, a);
      if (!reservation) {
        // this exact alert was already recorded (e.g. sent before a restart): just move the state on
        setWatchState(db, o.watch.id, o.lastBand, o.missedReads);
        continue;
      }
      try {
        await deps.sendMessage(chatId, a.text);
      } catch (e) {
        if (chatGone(e)) {
          db.prepare("DELETE FROM telegram_chats WHERE account_id = ?").run(a.accountId);
          log(`telegram chat closed for an account; unlinked (${telegramCode(e)})`);
        } else if (transient(e)) {
          release(o, reservation);
          if (telegramCode(e) === 401) log("Telegram bot token rejected (401); alerts will retry");
          else log(`telegram send failed, will retry next refresh: ${telegramText(e)}`);
        } else {
          log(`telegram send failed permanently (${telegramCode(e)}): ${telegramText(e)}`);
        }
      }
    }
  }

  return {
    /** register with reader.onUpdate */
    onUpdate(_prev: LoanState | null, next: LoanState): Promise<void> {
      queue = queue.then(() => cycle(next)).catch((e: unknown) => log(`alert cycle failed: ${e instanceof Error ? e.message : String(e)}`));
      return queue;
    },
  };
}
