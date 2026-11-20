import { describe, expect, it } from "vitest";
import { PARYON_APP_URL, type LoanView } from "@redline/api-types";
import { riskBand } from "@redline/paryon-decoder";
import { createAlertRunner, evaluate, MAX_ALERTS_PER_CYCLE, type Alert } from "../src/alerts.js";
import { openDb, type StoredBand, type WatchRow } from "../src/db.js";
import type { LoanState } from "../src/reader.js";

const PRICE = 200;
const L1 = "1a2b3c4d" + "0".repeat(56);
const L2 = "ffeeddcc" + "1".repeat(56);

/** a LoanView at a given distance to liquidation (price 200) */
const loan = (id: string, distance: number | null): LoanView => {
  const liq = distance === null ? null : PRICE * (1 - distance);
  return {
    id, status: "mature", debtPusd: distance === null ? 0 : 1000, collateralSats: 10e8, collateralBch: 10,
    interestRatePct: 1, nextInterestRatePct: 1, pendingRateChange: false,
    collateralRatioPct: liq === null ? null : (110 * PRICE) / liq,
    liquidationPriceUsd: liq, distanceToLiquidation: distance, risk: riskBand(distance),
    debtAheadPusd: 0, redemptionInProgress: false, amountBeingRedeemedPusd: 0, stranded: distance === null, paryonUrl: PARYON_APP_URL,
  };
};
const state = (loans: LoanView[]): LoanState => ({
  blockHeight: 1, priceUsd: PRICE, updatedAt: "2026-11-20T12:00:00.000Z", loans, byId: new Map(loans.map((l) => [l.id, l])),
});
const at = (d: number | null, id = L1) => state([loan(id, d)]);
const watch = (o: Partial<WatchRow> = {}): WatchRow => ({
  id: "w1", accountId: "acc", loanId: L1, rules: { liquidation: true, loanGone: true }, lastBand: null, mutedUntil: null, createdAt: 0, ...o,
});
const NOW = 1_800_000_000;

/** run a sequence of distances through evaluate, carrying last_band forward; returns the alerted bands per step */
function walk(distances: number[], start: StoredBand | null = "safe") {
  let band: StoredBand | null = start;
  let prev: LoanState | null = null;
  const alerted: Array<string | null> = [];
  for (const d of distances) {
    const next = at(d);
    const r = evaluate([watch({ lastBand: band })], prev, next, NOW);
    alerted.push(r.alerts[0]?.value ?? null);
    for (const u of r.bandUpdates) band = u.lastBand;
    prev = next;
  }
  return { alerted, band };
}

describe("evaluate: liquidation bands", () => {
  it("first evaluation: safe/watch set the band silently", () => {
    for (const [d, band] of [[0.5, "safe"], [0.2, "watch"]] as const) {
      const r = evaluate([watch()], null, at(d), NOW);
      expect(r.alerts).toEqual([]);
      expect(r.bandUpdates).toEqual([{ watchId: "w1", lastBand: band }]);
    }
  });

  it("first evaluation: danger/critical alert immediately", () => {
    for (const [d, band] of [[0.1, "danger"], [0.05, "critical"], [-0.02, "critical"]] as const) {
      const r = evaluate([watch()], null, at(d), NOW);
      expect(r.alerts.map((a) => [a.rule, a.value])).toEqual([["liquidation", band]]);
      expect(r.bandUpdates).toEqual([{ watchId: "w1", lastBand: band }]);
    }
  });

  it("worsening safe → watch → danger → critical alerts once per band", () => {
    expect(walk([0.3, 0.24, 0.2, 0.14, 0.12, 0.07, 0.05]).alerted).toEqual([null, "watch", null, "danger", null, "critical", null]);
  });

  it("jumping several bands at once alerts once with the worst band", () => {
    expect(walk([0.5, 0.05]).alerted).toEqual([null, "critical"]);
  });

  it("flapping around a threshold does not re-alert (hysteresis)", () => {
    const r = walk([0.16, 0.14, 0.16, 0.14, 0.17, 0.149, 0.1799], "watch");
    expect(r.alerted).toEqual([null, "danger", null, null, null, null, null]);
    expect(r.band).toBe("danger");
  });

  it("no alert on improvement; re-arms only after recovering 3 points past the threshold", () => {
    const r = walk([0.14, 0.17]);
    expect(r.alerted).toEqual(["danger", null]);
    expect(r.band).toBe("danger"); // 17% < 18%
    const r2 = walk([0.14, 0.18]);
    expect(r2.band).toBe("watch"); // exactly 18% re-arms
  });

  it("recovery re-arms, then the next drop alerts again", () => {
    expect(walk([0.14, 0.2, 0.14]).alerted).toEqual(["danger", null, "danger"]);
    expect(walk([0.05, 0.11, 0.07]).alerted).toEqual(["critical", null, "critical"]); // 11% = 8 + 3
    expect(walk([0.05, 0.3, 0.2]).alerted).toEqual(["critical", null, "watch"]); // recovered straight to safe
  });

  it("partial recovery moves the band back only as far as hysteresis allows", () => {
    // critical → 16%: past critical's 11% but not danger's 18% → danger
    const r = walk([0.05, 0.16]);
    expect(r.band).toBe("danger");
    expect(walk([0.05, 0.16, 0.14]).alerted).toEqual(["critical", null, null]);
  });

  it("debt repaid (distance null) counts as safe", () => {
    const r = walk([0.1, 0.1]);
    const s = evaluate([watch({ lastBand: r.band })], at(0.1), state([loan(L1, null)]), NOW);
    expect(s.alerts).toEqual([]);
    expect(s.bandUpdates).toEqual([{ watchId: "w1", lastBand: "safe" }]);
  });

  it("no band update when nothing changed", () => {
    expect(evaluate([watch({ lastBand: "watch" })], at(0.2), at(0.21), NOW).bandUpdates).toEqual([]);
  });

  it("liquidation rule off: band tracked, no alert", () => {
    const r = evaluate([watch({ lastBand: "safe", rules: { liquidation: false, loanGone: true } })], at(0.3), at(0.05), NOW);
    expect(r.alerts).toEqual([]);
    expect(r.bandUpdates).toEqual([{ watchId: "w1", lastBand: "critical" }]);
  });

  it("alert text: loan id, CR, distance, liq vs price, Paryon link, under 1000 chars", () => {
    const [a] = evaluate([watch({ lastBand: "safe" })], at(0.3), at(0.05), NOW).alerts as [Alert];
    expect(a.text).toContain("1a2b3c4d");
    expect(a.text).not.toContain(L1);
    expect(a.text).toMatch(/CRITICAL/);
    expect(a.text).toContain("115.8%"); // CR = 110 * 200 / 190
    expect(a.text).toContain("5.0%");
    expect(a.text).toContain("$190.00");
    expect(a.text).toContain("$200.00");
    expect(a.text).toContain(PARYON_APP_URL);
    expect(a.text.length).toBeLessThan(1000);
  });
});

describe("evaluate: loan gone", () => {
  const missing = (n: number) => new Map([[L1, n]]);

  it("absent for 2 consecutive refreshes → alert once and mark gone", () => {
    const next = state([loan(L2, 0.3)]);
    // first miss: nothing yet
    expect(evaluate([watch({ lastBand: "safe" })], at(0.3), next, NOW, missing(1))).toEqual({ alerts: [], bandUpdates: [] });
    const r = evaluate([watch({ lastBand: "safe" })], next, next, NOW, missing(2));
    expect(r.alerts.map((a) => [a.rule, a.value])).toEqual([["loan_gone", "gone"]]);
    expect(r.alerts[0]!.text).toMatch(/1a2b3c4d is gone — it was closed, fully repaid, or liquidated\. Check the Paryon app/);
    expect(r.alerts[0]!.text).toContain(PARYON_APP_URL);
    expect(r.bandUpdates).toEqual([{ watchId: "w1", lastBand: "gone" }]);
    // next cycle: still absent, already gone → nothing
    expect(evaluate([watch({ lastBand: "gone" })], next, next, NOW, missing(3))).toEqual({ alerts: [], bandUpdates: [] });
  });

  it("decided from the persisted band and miss count, not from prev", () => {
    // prev null (restart) or prev without the loan: still gone once missed twice
    expect(evaluate([watch({ lastBand: "watch" })], null, at(0.3, L2), NOW, missing(2)).alerts.map((a) => a.rule)).toEqual(["loan_gone"]);
    expect(evaluate([watch({ lastBand: "watch" })], at(0.3, L2), at(0.3, L2), NOW, missing(5)).alerts).toHaveLength(1);
    // never evaluated (null): unknown, leave it however long it is missing
    expect(evaluate([watch({ lastBand: null })], at(0.3), at(0.3, L2), NOW, missing(9))).toEqual({ alerts: [], bandUpdates: [] });
    // no miss count given → never gone
    expect(evaluate([watch({ lastBand: "watch" })], at(0.3), at(0.3, L2), NOW)).toEqual({ alerts: [], bandUpdates: [] });
  });

  it("loan-gone rule off: marked gone silently", () => {
    const r = evaluate([watch({ lastBand: "safe", rules: { liquidation: true, loanGone: false } })], at(0.3), at(0.3, L2), NOW, missing(2));
    expect(r.alerts).toEqual([]);
    expect(r.bandUpdates).toEqual([{ watchId: "w1", lastBand: "gone" }]);
  });

  it("reappearing clears gone and re-evaluates like a first evaluation", () => {
    const back = evaluate([watch({ lastBand: "gone" })], at(0.3, L2), at(0.2), NOW);
    expect(back.alerts).toEqual([]);
    expect(back.bandUpdates).toEqual([{ watchId: "w1", lastBand: "watch" }]);
    const risky = evaluate([watch({ lastBand: "gone" })], at(0.3, L2), at(0.1), NOW);
    expect(risky.alerts.map((a) => a.value)).toEqual(["danger"]);
  });
});

describe("evaluate: watch-level mute", () => {
  it("suppresses alerts but still updates the band", () => {
    const r = evaluate([watch({ lastBand: "safe", mutedUntil: NOW + 10 })], at(0.3), at(0.05), NOW);
    expect(r.alerts).toEqual([]);
    expect(r.bandUpdates).toEqual([{ watchId: "w1", lastBand: "critical" }]);
    expect(evaluate([watch({ lastBand: "safe", mutedUntil: NOW })], at(0.3), at(0.05), NOW).alerts).toHaveLength(1);
  });
});

describe("alert runner", () => {
  function setup(o: { failSend?: boolean } = {}) {
    const db = openDb(":memory:");
    const sent: Array<{ chatId: string; text: string }> = [];
    const logs: string[] = [];
    let fail: Error | null = o.failSend ? new Error("Network request for 'sendMessage' failed!") : null;
    const runner = createAlertRunner({
      db,
      now: () => NOW,
      log: (m) => logs.push(m),
      sendMessage: async (chatId, text) => {
        if (fail) throw fail;
        sent.push({ chatId, text });
      },
    });
    const addWatch = (id: string, accountId: string, loanId = L1, lastBand: StoredBand | null = "safe") => {
      db.insertWatch({ id, accountId, loanId, rules: { liquidation: true, loanGone: true }, createdAt: 0 });
      db.setWatchBand(id, lastBand);
      db.linkTelegramChat(accountId, `chat-${accountId}`, 0);
    };
    return { db, sent, logs, runner, addWatch, setFail: (e: Error | null) => (fail = e) };
  }

  it("restart with a partial first snapshot: no gone alert, no band change", async () => {
    const s = setup();
    s.addWatch("w1", "acc", L1, "danger");
    await s.runner.onUpdate(null, at(0.3, L2)); // L1 missing from the first snapshot after a restart
    expect(s.sent).toEqual([]);
    expect(s.db.getWatch("w1")!.lastBand).toBe("danger");
  });

  it("missing once then back: no gone", async () => {
    const s = setup();
    s.addWatch("w1", "acc", L1, "watch");
    await s.runner.onUpdate(at(0.2), at(0.3, L2));
    await s.runner.onUpdate(at(0.3, L2), at(0.2));
    await s.runner.onUpdate(at(0.2), at(0.3, L2)); // missing again: the count restarted
    expect(s.sent).toEqual([]);
    expect(s.db.getWatch("w1")!.lastBand).toBe("watch");
  });

  it("missing twice: exactly one gone alert", async () => {
    const s = setup();
    s.addWatch("w1", "acc", L1, "watch");
    const gone = at(0.3, L2);
    for (let i = 0; i < 4; i++) await s.runner.onUpdate(gone, gone);
    expect(s.sent.map((m) => /is gone/.test(m.text))).toEqual([true]);
    expect(s.db.getWatch("w1")!.lastBand).toBe("gone");
  });

  it("a capped gone alert is sent next cycle", async () => {
    const s = setup();
    const ids = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(64, "0"));
    ids.forEach((id, i) => s.addWatch(`w${i}`, `acc${i}`, id));
    s.addWatch("wg", "accg", L1, "watch");
    const safe = state(ids.map((id) => loan(id, 0.3)));
    const risky = state(ids.map((id) => loan(id, 0.05)));
    await s.runner.onUpdate(null, safe); // L1 miss 1
    await s.runner.onUpdate(safe, risky); // L1 miss 2 → gone, but 20 critical alerts come first → capped
    expect(s.sent).toHaveLength(20);
    expect(s.sent.some((m) => /is gone/.test(m.text))).toBe(false);
    expect(s.db.getWatch("wg")!.lastBand).toBe("watch");
    await s.runner.onUpdate(risky, risky);
    expect(s.sent).toHaveLength(21);
    expect(s.sent[20]!.text).toMatch(/is gone/);
    expect(s.db.getWatch("wg")!.lastBand).toBe("gone");
  });

  it("each watch's band is persisted right after its own send", async () => {
    const db = openDb(":memory:");
    const seen: Array<string | null> = [];
    const runner = createAlertRunner({ db, now: () => NOW, log: () => {}, sendMessage: async () => void seen.push(db.getWatch("w1")!.lastBand) });
    for (const [id, acc, loanId] of [["w1", "a1", L1], ["w2", "a2", L2]] as const) {
      db.insertWatch({ id, accountId: acc, loanId, rules: { liquidation: true, loanGone: true }, createdAt: 0 });
      db.setWatchBand(id, "safe");
      db.linkTelegramChat(acc, acc, 0);
    }
    const s = state([loan(L1, 0.05), loan(L2, 0.1)]);
    await runner.onUpdate(s, s);
    expect(seen).toEqual(["safe", "critical"]); // w1 (critical) goes first and is saved before w2's send
  });

  it("send failure other than 403 keeps the old band, so it retries next refresh", async () => {
    const s = setup({ failSend: true });
    s.addWatch("w1", "acc");
    await s.runner.onUpdate(at(0.3), at(0.05));
    expect(s.db.getWatch("w1")!.lastBand).toBe("safe");
    expect(s.db.alertsFor("w1")).toEqual([]);
    expect(s.logs.some((l) => /send failed/.test(l))).toBe(true);
    s.setFail(null);
    await s.runner.onUpdate(at(0.05), at(0.05));
    expect(s.sent).toHaveLength(1);
    expect(s.db.getWatch("w1")!.lastBand).toBe("critical");
  });

  it("403 (blocked/kicked): band advances and the chat is unlinked", async () => {
    const s = setup();
    s.addWatch("w1", "acc");
    s.setFail(Object.assign(new Error("Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)"), { error_code: 403 }));
    await s.runner.onUpdate(at(0.3), at(0.05));
    expect(s.db.getWatch("w1")!.lastBand).toBe("critical");
    expect(s.db.getTelegramChat("acc")).toBeNull();
    expect(s.logs.some((l) => /unlinked/.test(l))).toBe(true);
  });

  it("400 chat not found: band advances and the chat is unlinked", async () => {
    const s = setup();
    s.addWatch("w1", "acc");
    s.setFail(Object.assign(new Error("Call to 'sendMessage' failed! (400: Bad Request: chat not found)"), { error_code: 400, description: "Bad Request: chat not found" }));
    await s.runner.onUpdate(at(0.3), at(0.05));
    expect(s.db.getWatch("w1")!.lastBand).toBe("critical");
    expect(s.db.getTelegramChat("acc")).toBeNull();
  });

  it("other 4xx (not 429) is permanent: band advances, chat stays linked, no retry", async () => {
    const s = setup();
    s.addWatch("w1", "acc");
    s.setFail(Object.assign(new Error("Call to 'sendMessage' failed! (400: Bad Request: message is too long)"), { error_code: 400, description: "Bad Request: message is too long" }));
    await s.runner.onUpdate(at(0.3), at(0.05));
    expect(s.db.getWatch("w1")!.lastBand).toBe("critical");
    expect(s.db.getTelegramChat("acc")).not.toBeNull();
    s.setFail(null);
    await s.runner.onUpdate(at(0.05), at(0.05));
    expect(s.sent).toHaveLength(0);
  });

  it("401 (bot token rejected) is transient: bands kept, chats kept, one loud log line per cycle", async () => {
    const s = setup();
    s.addWatch("w1", "acc");
    s.addWatch("w2", "acc2");
    s.setFail(Object.assign(new Error("Call to 'sendMessage' failed! (401: Unauthorized)"), { error_code: 401 }));
    await s.runner.onUpdate(at(0.3), at(0.05));
    expect(s.db.getWatch("w1")!.lastBand).toBe("safe");
    expect(s.db.getWatch("w2")!.lastBand).toBe("safe");
    expect(s.db.getTelegramChat("acc")).not.toBeNull();
    expect(s.logs.filter((l) => l.includes("Telegram bot token rejected (401)"))).toHaveLength(1);
    s.setFail(null);
    await s.runner.onUpdate(at(0.05), at(0.05));
    expect(s.sent).toHaveLength(2);
  });

  it("429 and 5xx stay transient: old band kept, retried next refresh", async () => {
    for (const code of [429, 502]) {
      const s = setup();
      s.addWatch("w1", "acc");
      s.setFail(Object.assign(new Error(`Call to 'sendMessage' failed! (${code})`), { error_code: code }));
      await s.runner.onUpdate(at(0.3), at(0.05));
      expect(s.db.getWatch("w1")!.lastBand, String(code)).toBe("safe");
      expect(s.db.getTelegramChat("acc")).not.toBeNull();
    }
  });

  it("sends to the linked chat, records alerts_sent, updates last_band", async () => {
    const s = setup();
    s.addWatch("w1", "acc");
    s.db.linkTelegramChat("acc", "555", 0);
    await s.runner.onUpdate(at(0.3), at(0.1));
    expect(s.sent.map((m) => m.chatId)).toEqual(["555"]);
    expect(s.db.alertsFor("w1")).toEqual([{ watchId: "w1", rule: "liquidation", value: "danger", sentAt: NOW }]);
    expect(s.db.getWatch("w1")!.lastBand).toBe("danger");
    await s.runner.onUpdate(at(0.1), at(0.1));
    expect(s.sent).toHaveLength(1);
  });

  it("muted chat: no send, band still updated (no burst later)", async () => {
    const s = setup();
    s.addWatch("w1", "acc");
    s.db.linkTelegramChat("acc", "555", 0);
    s.db.setChatMute("555", NOW + 60);
    await s.runner.onUpdate(at(0.3), at(0.05));
    expect(s.sent).toEqual([]);
    expect(s.db.alertsFor("w1")).toEqual([]);
    expect(s.db.getWatch("w1")!.lastBand).toBe("critical");
  });

  it("unlinked account: no send, band still updated", async () => {
    const s = setup();
    s.addWatch("w1", "acc");
    s.db.unlinkTelegram("acc");
    await s.runner.onUpdate(at(0.3), at(0.05));
    expect(s.sent).toEqual([]);
    expect(s.db.getWatch("w1")!.lastBand).toBe("critical");
  });

  it("send failure is logged, never thrown", async () => {
    const s = setup({ failSend: true });
    s.addWatch("w1", "acc");
    s.db.linkTelegramChat("acc", "555", 0);
    await expect(s.runner.onUpdate(at(0.3), at(0.05))).resolves.toBeUndefined();
    expect(s.logs.some((l) => l.includes("sendMessage' failed"))).toBe(true);
    expect(s.db.alertsFor("w1")).toEqual([]);
  });

  it(`caps sends at ${MAX_ALERTS_PER_CYCLE} per cycle, logs it, and leaves capped watches to the next cycle`, async () => {
    const s = setup();
    const loans: LoanView[] = [];
    for (let i = 0; i < 25; i++) {
      const id = i.toString(16).padStart(64, "0");
      loans.push(loan(id, 0.05));
      s.addWatch(`w${i}`, `acc${i}`, id);
      s.db.linkTelegramChat(`acc${i}`, String(1000 + i), 0);
    }
    const next = state(loans);
    await s.runner.onUpdate(next, next);
    expect(s.sent).toHaveLength(20);
    expect(s.logs.some((l) => /capped/.test(l) && /5/.test(l))).toBe(true);
    const stillSafe = s.db.allWatches().filter((w) => w.lastBand === "safe");
    expect(stillSafe).toHaveLength(5);
    await s.runner.onUpdate(next, next);
    expect(s.sent).toHaveLength(25);
  });

  it("the most severe alerts go first when capped", async () => {
    const s = setup();
    const loans: LoanView[] = [];
    for (let i = 0; i < 22; i++) {
      const id = i.toString(16).padStart(64, "0");
      loans.push(loan(id, i < 2 ? 0.2 : i < 4 ? 0.05 : 0.1)); // 2 watch, 2 critical, 18 danger
      s.addWatch(`w${i}`, `acc${i}`, id);
      s.db.linkTelegramChat(`acc${i}`, String(1000 + i), 0);
    }
    await s.runner.onUpdate(state(loans), state(loans));
    expect(s.sent).toHaveLength(20);
    expect(s.sent.slice(0, 2).every((m) => /CRITICAL/.test(m.text))).toBe(true);
    expect(s.sent.some((m) => /WATCH/.test(m.text))).toBe(false);
  });

  it("overlapping cycles run one after the other", async () => {
    const s = setup();
    s.addWatch("w1", "acc");
    s.db.linkTelegramChat("acc", "555", 0);
    await Promise.all([s.runner.onUpdate(at(0.3), at(0.05)), s.runner.onUpdate(at(0.05), at(0.05))]);
    expect(s.sent).toHaveLength(1);
  });
});
