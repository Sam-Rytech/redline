import { describe, expect, it } from "vitest";
import type { LoanView } from "@redline/api-types";
import { computeLoanViews, type RawLoan } from "@redline/paryon-decoder";
import { createAlertRunner, evaluate, GONE_AFTER_MISSES, MAX_ALERTS_PER_CYCLE, nextBand } from "../src/alerts.js";
import { upsertAccount } from "../src/db/auth.js";
import { openDatabase } from "../src/db/open.js";
import { allWatches, insertWatch, type WatchRow } from "../src/db/watches.js";
import type { LoanState } from "../src/reader.js";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const PRICE = 200;
/** a loan whose distance to liquidation is `d` at PRICE (liq = PRICE * (1 - d)) */
const loanAt = (id: string, d: number): RawLoan => {
  const liq = PRICE * (1 - d);
  // liq = debt / bch * 1.1 with bch = 10
  return { id, status: "mature", debtPusd: (liq * 10) / 1.1, collateralSats: 10e8, rateRaw: 274, nextRateRaw: 274, amountBeingRedeemedPusd: 0 };
};
const stateOf = (loans: RawLoan[], updatedAt = NOW): LoanState => {
  const views = computeLoanViews(loans, PRICE);
  return { blockHeight: 1, priceUsd: PRICE, updatedAt: updatedAt.toISOString(), loans: views, byId: new Map(views.map((v) => [v.id, v])), raw: loans, missingSidecars: 0 };
};
const watch = (over: Partial<WatchRow> = {}): WatchRow => ({
  id: "w1", accountId: "acc", loanId: "L", rules: { liquidation: true, loanGone: true }, lastBand: null, missedReads: 0, createdAt: 1, ...over,
});
const notMuted = () => false;

describe("nextBand (bands 25 / 15 / 8 %, 3-point re-arm)", () => {
  it("moves to a worse band at once and back only after recovering 3 points past the threshold", () => {
    expect(nextBand("safe", 0.2)).toBe("watch");
    expect(nextBand("watch", 0.1)).toBe("danger");
    expect(nextBand("danger", 0.16)).toBe("danger"); // above 15 % but not yet 18 %
    expect(nextBand("danger", 0.18)).toBe("watch");
    expect(nextBand("critical", 0.1)).toBe("critical"); // needs 11 %
    expect(nextBand("critical", 0.11)).toBe("danger");
    expect(nextBand("watch", 0.4)).toBe("safe");
  });
});

describe("evaluate", () => {
  it("first look: safe is recorded silently, danger or critical alerts at once", () => {
    const [safe] = evaluate([watch()], stateOf([loanAt("L", 0.4)]), notMuted);
    expect(safe).toMatchObject({ lastBand: "safe", alert: null });
    const [crit] = evaluate([watch()], stateOf([loanAt("L", 0.05)]), notMuted);
    expect(crit!.lastBand).toBe("critical");
    expect(crit!.alert).toMatchObject({ rule: "liquidation", band: "critical" });
  });

  it("alerts once per worse band; one alert for a jump across bands; none on improvement (PRD R6)", () => {
    expect(evaluate([watch({ lastBand: "safe" })], stateOf([loanAt("L", 0.2)]), notMuted)[0]!.alert!.band).toBe("watch");
    expect(evaluate([watch({ lastBand: "watch" })], stateOf([loanAt("L", 0.2)]), notMuted)[0]!.alert).toBeNull();
    const jump = evaluate([watch({ lastBand: "safe" })], stateOf([loanAt("L", 0.05)]), notMuted)[0]!;
    expect(jump.alert!.band).toBe("critical");
    expect(evaluate([watch({ lastBand: "critical" })], stateOf([loanAt("L", 0.3)]), notMuted)[0]!.alert).toBeNull();
  });

  it("flapping around 15 % does not re-alert; recovering to 18 % re-arms", () => {
    let w = watch({ lastBand: "watch" });
    const step = (d: number) => {
      const o = evaluate([w], stateOf([loanAt("L", d)]), notMuted)[0]!;
      w = { ...w, lastBand: o.lastBand };
      return o.alert?.band ?? null;
    };
    expect(step(0.14)).toBe("danger");
    expect(step(0.16)).toBeNull();
    expect(step(0.14)).toBeNull();
    expect(step(0.19)).toBeNull(); // re-armed to watch
    expect(step(0.14)).toBe("danger"); // alerts again
  });

  it("a loan is gone only after 3 consecutive reads without it, and a known band (PRD R2)", () => {
    expect(GONE_AFTER_MISSES).toBe(3);
    let w = watch({ lastBand: "danger" });
    const read = () => {
      const o = evaluate([w], stateOf([loanAt("other", 0.4)]), notMuted)[0]!;
      w = { ...w, lastBand: o.lastBand, missedReads: o.missedReads };
      return o;
    };
    expect(read()).toMatchObject({ missedReads: 1, lastBand: "danger", alert: null });
    expect(read()).toMatchObject({ missedReads: 2, lastBand: "danger", alert: null });
    const third = read();
    expect(third).toMatchObject({ missedReads: 3, lastBand: "gone" });
    expect(third.alert).toMatchObject({ rule: "loan_gone", band: "gone" });
    expect(read().alert).toBeNull(); // reported once
  });

  it("a loan seen again resets the miss count; a never-evaluated watch is never 'gone'", () => {
    const back = evaluate([watch({ lastBand: "danger", missedReads: 2 })], stateOf([loanAt("L", 0.1)]), notMuted)[0]!;
    expect(back.missedReads).toBe(0);
    const fresh = evaluate([watch({ missedReads: 5 })], stateOf([loanAt("x", 0.4)]), notMuted)[0]!;
    expect(fresh.alert).toBeNull();
    expect(fresh.lastBand).toBeNull();
  });

  it("muted accounts and switched-off rules get no message, but the band still moves", () => {
    const m = evaluate([watch({ lastBand: "safe" })], stateOf([loanAt("L", 0.05)]), () => true)[0]!;
    expect(m).toMatchObject({ lastBand: "critical", alert: null });
    const off = evaluate([watch({ lastBand: "safe", rules: { liquidation: false, loanGone: true } })], stateOf([loanAt("L", 0.05)]), notMuted)[0]!;
    expect(off).toMatchObject({ lastBand: "critical", alert: null });
  });

  it("stranded loans (no debt) count as safe", () => {
    const stranded: RawLoan = { ...loanAt("L", 0.5), debtPusd: 0 };
    expect(evaluate([watch({ lastBand: "watch" })], stateOf([stranded]), notMuted)[0]!.lastBand).toBe("safe");
  });

  it("messages follow BRAND.md: plain numbers, no emojis, a link to the Paryon app", () => {
    const text = evaluate([watch({ lastBand: "safe" })], stateOf([loanAt("L", 0.08)]), notMuted)[0]!.alert!.text;
    expect(text).toMatch(/is 8% from liquidation/);
    expect(text).toMatch(/BCH at \$184\.00 or below loses the collateral\. BCH is \$200\.00 now\./);
    expect(text).toContain("https://paryonusd.com/app");
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(text).not.toMatch(/!/);
  });
});

describe("alert runner", () => {
  const setup = (o: { send?: (chatId: string, text: string) => Promise<void>; muted?: boolean; linked?: boolean } = {}) => {
    const db = openDatabase(":memory:");
    upsertAccount(db, "acc", 1);
    if (o.muted) db.prepare("UPDATE accounts SET muted = 1 WHERE id = 'acc'").run();
    if (o.linked !== false) db.prepare("INSERT INTO telegram_chats (account_id, chat_id, linked_at) VALUES ('acc', '42', 1)").run();
    insertWatch(db, { id: "w1", accountId: "acc", loanId: "L", rules: { liquidation: true, loanGone: true }, createdAt: 1 });
    const sent: Array<[string, string]> = [];
    const logs: string[] = [];
    const runner = createAlertRunner({
      db,
      now: () => NOW,
      log: (m) => logs.push(m),
      sendMessage: o.send ?? (async (chatId, text) => void sent.push([chatId, text])),
    });
    const band = () => allWatches(db)[0]!.lastBand;
    const alertsSent = () => db.prepare("SELECT rule, band, arming FROM alerts_sent ORDER BY sent_at, arming").all();
    return { db, runner, sent, logs, band, alertsSent };
  };

  it("sends to the linked chat and records the alert with its arming number", async () => {
    const s = setup();
    await s.runner.onUpdate(null, stateOf([loanAt("L", 0.05)]));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]![0]).toBe("42");
    expect(s.band()).toBe("critical");
    expect(s.alertsSent()).toEqual([{ rule: "liquidation", band: "critical", arming: 1 }]);
    await s.runner.onUpdate(null, stateOf([loanAt("L", 0.05)]));
    expect(s.sent).toHaveLength(1);
  });

  it("re-arming gives the next alert a new arming number", async () => {
    const s = setup();
    await s.runner.onUpdate(null, stateOf([loanAt("L", 0.1)])); // danger, arming 1
    await s.runner.onUpdate(null, stateOf([loanAt("L", 0.3)])); // recovers to safe
    await s.runner.onUpdate(null, stateOf([loanAt("L", 0.1)])); // danger again, arming 2
    expect(s.sent).toHaveLength(2);
    expect(s.alertsSent()).toEqual([
      { rule: "liquidation", band: "danger", arming: 1 },
      { rule: "liquidation", band: "danger", arming: 2 },
    ]);
  });

  it("sends nothing from stale data (older than 5 minutes)", async () => {
    const s = setup();
    await s.runner.onUpdate(null, stateOf([loanAt("L", 0.05)], new Date(NOW.getTime() - 6 * 60_000)));
    expect(s.sent).toHaveLength(0);
    expect(s.band()).toBeNull();
  });

  it("a muted or unlinked account gets nothing but its band moves", async () => {
    for (const o of [{ muted: true }, { linked: false }]) {
      const s = setup(o);
      await s.runner.onUpdate(null, stateOf([loanAt("L", 0.05)]));
      expect(s.sent).toHaveLength(0);
      expect(s.band()).toBe("critical");
    }
  });

  it("a temporary Telegram failure undoes the reservation and the next refresh retries", async () => {
    let fail = true;
    const sent: string[] = [];
    const s = setup({
      send: async (_c, text) => {
        if (fail) throw Object.assign(new Error("Too Many Requests"), { error_code: 429 });
        sent.push(text);
      },
    });
    await s.runner.onUpdate(null, stateOf([loanAt("L", 0.05)]));
    expect(s.band()).toBeNull();
    expect(s.alertsSent()).toEqual([]);
    fail = false;
    await s.runner.onUpdate(null, stateOf([loanAt("L", 0.05)]));
    expect(sent).toHaveLength(1);
    expect(s.band()).toBe("critical");
  });

  it("a revoked bot token (401) is retried, not dropped", async () => {
    const s = setup({ send: async () => Promise.reject(Object.assign(new Error("Unauthorized"), { error_code: 401 })) });
    await s.runner.onUpdate(null, stateOf([loanAt("L", 0.05)]));
    expect(s.band()).toBeNull();
    expect(s.logs.some((l) => l.includes("401"))).toBe(true);
  });

  it("a blocked bot (403) or a deleted chat unlinks the chat and keeps the alert recorded", async () => {
    for (const e of [Object.assign(new Error("Forbidden: bot was blocked"), { error_code: 403 }), Object.assign(new Error("Bad Request: chat not found"), { error_code: 400 })]) {
      const s = setup({ send: async () => Promise.reject(e) });
      await s.runner.onUpdate(null, stateOf([loanAt("L", 0.05)]));
      expect(s.db.prepare("SELECT count(*) AS n FROM telegram_chats").get()).toEqual({ n: 0 });
      expect(s.band()).toBe("critical");
    }
  });

  it("saves the alert record and the new band before sending, so a crash mid-send cannot repeat it after a restart", async () => {
    let seenDuringSend: unknown = null;
    const s = setup({
      send: async () => {
        seenDuringSend = {
          band: allWatches(s.db)[0]!.lastBand,
          rows: s.db.prepare("SELECT rule, band, arming FROM alerts_sent").all(),
        };
        throw new Error("process killed"); // no error_code: treated like a network failure
      },
    });
    await s.runner.onUpdate(null, stateOf([loanAt("L", 0.05)]));
    expect(seenDuringSend).toEqual({ band: "critical", rows: [{ rule: "liquidation", band: "critical", arming: 1 }] });
  });

  it("the unique key refuses a second record of the same alert", () => {
    const s = setup();
    const insert = () =>
      s.db.prepare("INSERT INTO alerts_sent (id, watch_id, rule, band, arming, sent_at) VALUES (?, 'w1', 'liquidation', 'critical', 1, 1)").run(Math.random().toString());
    insert();
    expect(insert).toThrow(/UNIQUE/);
  });

  it(`sends at most ${MAX_ALERTS_PER_CYCLE} per refresh, most severe first; the rest go next time`, async () => {
    const s = setup();
    const loans: RawLoan[] = [];
    for (let i = 0; i < MAX_ALERTS_PER_CYCLE + 5; i++) {
      insertWatch(s.db, { id: `x${i}`, accountId: "acc", loanId: `L${i}`, rules: { liquidation: true, loanGone: true }, createdAt: 2 });
      loans.push(loanAt(`L${i}`, i < 5 ? 0.05 : 0.1));
    }
    await s.runner.onUpdate(null, stateOf(loans));
    expect(s.sent).toHaveLength(MAX_ALERTS_PER_CYCLE);
    expect(s.sent.slice(0, 5).every(([, t]) => t.includes("5% from"))).toBe(true);
    await s.runner.onUpdate(null, stateOf(loans));
    expect(s.sent).toHaveLength(MAX_ALERTS_PER_CYCLE + 5);
  });

  it("cycles never overlap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const s = setup({
      send: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
    });
    insertWatch(s.db, { id: "w2", accountId: "acc", loanId: "M", rules: { liquidation: true, loanGone: true }, createdAt: 2 });
    await Promise.all([
      s.runner.onUpdate(null, stateOf([loanAt("L", 0.05), loanAt("M", 0.05)])),
      s.runner.onUpdate(null, stateOf([loanAt("L", 0.05), loanAt("M", 0.05)])),
    ]);
    expect(maxInFlight).toBe(1);
  });
});

export type { LoanView };
