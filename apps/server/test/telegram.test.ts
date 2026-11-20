import { describe, expect, it } from "vitest";
import { PARYON_APP_URL, type LoanView } from "@redline/api-types";
import { computeLoanViews } from "@redline/paryon-decoder";
import { openDb } from "../src/db.js";
import type { LoanState } from "../src/reader.js";
import { handleCommand, parseDuration } from "../src/telegram/commands.js";
import { tokenHash } from "../src/tokens.js";

const NOW = 1_800_000_000;
const L1 = "1a2b3c4d" + "0".repeat(56);
const L2 = "99887766" + "1".repeat(56);
// price 200: debt 1800 / 10 BCH → liq 198 (1% away, critical); debt 1000 → liq 110 (45%, safe)
const views: LoanView[] = computeLoanViews(
  [
    { id: L1, status: "mature", debtPusd: 1800, collateralSats: 10e8, interestRatePct: 1, nextInterestRatePct: 1, amountBeingRedeemedPusd: 0 },
  ],
  200,
);
const loanState: LoanState = { blockHeight: 1, priceUsd: 200, updatedAt: "", loans: views, byId: new Map(views.map((v) => [v.id, v])) };

function setup(o: { state?: LoanState | null; publicOrigin?: string } = {}) {
  const db = openDb(":memory:");
  let now = NOW;
  const deps = {
    db,
    reader: { current: () => (o.state === undefined ? loanState : o.state) },
    now: () => now,
    ...(o.publicOrigin && { publicOrigin: o.publicOrigin }),
  };
  const say = (text: string, chatId = "555") => handleCommand({ text, chatId }, deps);
  return { db, say, setNow: (t: number) => (now = t) };
}
const EXPIRED = "That link has expired. Open Redline and press Connect Telegram again.";

describe("/start", () => {
  it("valid token links the chat (once)", () => {
    const s = setup();
    s.db.insertLinkToken(tokenHash("tok_A-1"), "acc", NOW - 10, NOW + 590);
    expect(s.say("/start tok_A-1")).toBe("✅ Linked. You'll get Redline alerts here. /status to see your watches.");
    expect(s.db.getTelegramChat("acc")!.chatId).toBe("555");
    expect(s.say("/start tok_A-1", "777")).toBe(EXPIRED); // used
    expect(s.db.getTelegramChat("acc")!.chatId).toBe("555");
  });

  it("expired or unknown token", () => {
    const s = setup();
    s.db.insertLinkToken(tokenHash("old"), "acc", NOW - 700, NOW - 100);
    expect(s.say("/start old")).toBe(EXPIRED);
    expect(s.say("/start nope")).toBe(EXPIRED);
    expect(s.say("/start bad!chars")).toBe(EXPIRED);
    expect(s.say(`/start ${"a".repeat(65)}`)).toBe(EXPIRED);
    expect(s.db.accountForChat("555")).toBeNull();
  });

  it("accepts the /start@BotName form", () => {
    const s = setup();
    s.db.insertLinkToken(tokenHash("tok"), "acc", NOW, NOW + 600);
    expect(s.say("/start@RedlineBot tok")).toMatch(/^✅ Linked/);
  });

  it("no token: intro with the site link", () => {
    expect(setup({ publicOrigin: "https://redline.app" }).say("/start")).toMatch(/https:\/\/redline\.app/);
    expect(setup().say("/start")).toMatch(/the Redline site/);
  });
});

describe("/status", () => {
  it("unlinked chat", () => {
    expect(setup().say("/status")).toMatch(/^This chat isn't linked yet/);
  });

  it("lists watches with CR, distance, liq price, band; closed loans", () => {
    const s = setup();
    s.db.linkTelegramChat("acc", "555", NOW);
    s.db.insertWatch({ id: "w1", accountId: "acc", loanId: L1, rules: { liquidation: true, loanGone: true }, createdAt: 1 });
    s.db.insertWatch({ id: "w2", accountId: "acc", loanId: L2, rules: { liquidation: true, loanGone: true }, createdAt: 2 });
    s.db.insertWatch({ id: "w3", accountId: "other", loanId: L1, rules: { liquidation: true, loanGone: true }, createdAt: 3 });
    const out = s.say("/status");
    expect(out).toContain("1a2b3c4d");
    expect(out).not.toContain(L1);
    expect(out).toContain("CR 111.1%");
    expect(out).toContain("1.0% from liquidation");
    expect(out).toContain("liq $198.00");
    expect(out).toContain("CRITICAL");
    expect(out).toMatch(/99887766.*loan closed/);
    expect(out.match(/1a2b3c4d/g)).toHaveLength(1); // the other account's watch is not listed
    expect(out).toContain(PARYON_APP_URL);
  });

  it("truncates to fit 4000 chars with '…and N more'", () => {
    const s = setup();
    s.db.linkTelegramChat("acc", "555", NOW);
    for (let i = 0; i < 200; i++) {
      s.db.insertWatch({ id: `w${i}`, accountId: "acc", loanId: "ee".repeat(30) + String(i).padStart(4, "0"), rules: { liquidation: true, loanGone: true }, createdAt: i });
    }
    s.db.insertWatch({ id: "wl", accountId: "acc", loanId: L1, rules: { liquidation: true, loanGone: true }, createdAt: 999 });
    const out = s.say("/status");
    expect(out.length).toBeLessThanOrEqual(4000);
    const m = /…and (\d+) more/.exec(out);
    expect(m).not.toBeNull();
    const shown = (out.match(/ — /g) ?? []).length;
    expect(shown + Number(m![1])).toBe(201);
  });

  it("no watches; data still loading; muted note", () => {
    const s = setup({ state: null });
    s.db.linkTelegramChat("acc", "555", NOW);
    expect(s.say("/status")).toMatch(/no watches/i);
    s.db.insertWatch({ id: "w1", accountId: "acc", loanId: L1, rules: { liquidation: true, loanGone: true }, createdAt: 1 });
    expect(s.say("/status")).toMatch(/loading/i);
    s.db.setChatMute("555", NOW + 3600);
    expect(s.say("/status")).toMatch(/muted until/i);
  });
});

describe("/mute and /unmute", () => {
  it("parseDuration", () => {
    expect(parseDuration(undefined)).toBe(86400);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("30m")).toBe(1800);
    expect(parseDuration("3d")).toBe(3 * 86400);
    expect(parseDuration("7d")).toBe(7 * 86400);
    expect(parseDuration("8d")).toBe(7 * 86400); // capped
    expect(parseDuration("200h")).toBe(7 * 86400);
    for (const bad of ["0m", "abc", "2", "-1h", "1.5h", "2w"]) expect(parseDuration(bad)).toBeNull();
  });

  it("mutes the chat for 24 h by default, or the given time; unmute clears", () => {
    const s = setup();
    s.db.linkTelegramChat("acc", "555", NOW);
    expect(s.say("/mute")).toMatch(/muted until 2027-01-16 08:00 UTC/i);
    expect(s.db.getTelegramChat("acc")!.mutedUntil).toBe(NOW + 86400);
    s.say("/mute 30m");
    expect(s.db.getTelegramChat("acc")!.mutedUntil).toBe(NOW + 1800);
    expect(s.say("/mute soon")).toMatch(/\/mute 2h/);
    expect(s.db.getTelegramChat("acc")!.mutedUntil).toBe(NOW + 1800);
    expect(s.say("/unmute")).toMatch(/back on/i);
    expect(s.db.getTelegramChat("acc")!.mutedUntil).toBeNull();
  });

  it("unlinked chat cannot mute", () => {
    expect(setup().say("/mute")).toMatch(/^This chat isn't linked yet/);
    expect(setup().say("/unmute")).toMatch(/^This chat isn't linked yet/);
  });
});

describe("/help and others", () => {
  it("/help lists the commands", () => {
    const out = setup().say("/help");
    for (const c of ["/status", "/mute", "/unmute", "/help"]) expect(out).toContain(c);
  });

  it("unknown commands and plain text point to /help", () => {
    expect(setup().say("/frobnicate")).toMatch(/\/help/);
    expect(setup().say("hello")).toMatch(/\/help/);
  });
});
