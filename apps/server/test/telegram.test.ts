import { describe, expect, it } from "vitest";
import type { ApiError, TelegramLinkResponse } from "@redline/api-types";
import { computeLoanViews, type RawLoan } from "@redline/paryon-decoder";
import { createAlertRunner } from "../src/alerts.js";
import { randomHex, sha256Hex } from "../src/crypto.js";
import { insertSession, upsertAccount } from "../src/db/auth.js";
import type { Db } from "../src/db/open.js";
import { insertWatch } from "../src/db/watches.js";
import { HELP, MAX_REPLY_CHARS, handleCommand } from "../src/telegram/commands.js";
import type { ChainReader, LoanState } from "../src/reader.js";
import { TEST_ORIGIN, testApp } from "./support.js";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const nowSec = Math.floor(NOW.getTime() / 1000);
const PRICE = 200;
const loanAt = (id: string, d: number): RawLoan => ({
  id, status: "mature", debtPusd: (PRICE * (1 - d) * 10) / 1.1, collateralSats: 10e8, rateRaw: 274, nextRateRaw: 274, amountBeingRedeemedPusd: 0,
});
const stateOf = (loans: RawLoan[]): LoanState => {
  const views = computeLoanViews(loans, PRICE);
  return { blockHeight: 1, priceUsd: PRICE, updatedAt: NOW.toISOString(), loans: views, byId: new Map(views.map((v) => [v.id, v])), raw: loans, missingSidecars: 0 };
};
const LOAN = "ab".repeat(32);
const STRANDED: RawLoan = { ...loanAt("cd".repeat(32), 0.5), debtPusd: 0, collateralSats: 3_5000_0000 };
const state = stateOf([loanAt(LOAN, 0.2), STRANDED]);
const reader = (s: LoanState | null): ChainReader => ({ current: () => s, lastError: () => null, refresh: async () => {}, start() {}, stop() {}, onUpdate() {} });

function setup(o: { bot?: boolean } = {}) {
  const { app, db, secrets } = testApp({ reader: reader(state), now: () => NOW, ...(o.bot !== false && { botUsername: () => "RedlineTestBot" }) });
  const account = (id: string) => {
    upsertAccount(db, id, nowSec);
    const token = randomHex(32);
    const sid = sha256Hex(token);
    insertSession(db, { id: sid, accountId: id, keysEnc: secrets.seal("{}", sid), createdAt: nowSec, expiresAt: nowSec + 3600 });
    return `rl_session=${token}`;
  };
  const post = async (path: string, cookie?: string) => {
    const res = await app.request(path, {
      method: "POST",
      headers: { origin: TEST_ORIGIN, "content-type": "application/json", ...(cookie && { cookie }) },
      body: "{}",
    });
    const text = await res.text();
    return { status: res.status, json: <T>() => JSON.parse(text) as T };
  };
  const cmd = (text: string, chatId = "100", now = nowSec) => handleCommand({ text, chatId }, { db, reader: reader(state), now: () => now, publicOrigin: TEST_ORIGIN });
  return { db, account, post, cmd };
}

const chatsOf = (db: Db) => db.prepare("SELECT account_id, chat_id FROM telegram_chats ORDER BY account_id").all();

describe("Telegram link token (docs/SECURITY.md)", () => {
  it("issues a single-use, 10-minute, 128-bit token, stored only as a hash", async () => {
    const s = setup();
    const r = await s.post("/api/telegram/link-token", s.account("acc"));
    expect(r.status).toBe(200);
    const body = r.json<TelegramLinkResponse>();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.url).toBe(`https://t.me/RedlineTestBot?start=${body.token}`);
    expect(body.expiresAt).toBe(new Date((nowSec + 600) * 1000).toISOString());
    const rows = s.db.prepare("SELECT token_hash FROM telegram_links").all() as { token_hash: string }[];
    expect(rows).toEqual([{ token_hash: sha256Hex(body.token) }]);
  });

  it("401 without a session; 503 telegram_unavailable when no bot is configured", async () => {
    expect((await setup().post("/api/telegram/link-token")).status).toBe(401);
    const s = setup({ bot: false });
    const r = await s.post("/api/telegram/link-token", s.account("acc"));
    expect(r.status).toBe(503);
    expect(r.json<ApiError>().error.code).toBe("telegram_unavailable");
  });

  it("/start with the token links the chat once; a reused, expired or unknown token does not", async () => {
    const s = setup();
    const { token } = (await s.post("/api/telegram/link-token", s.account("acc"))).json<TelegramLinkResponse>();
    expect(s.cmd(`/start ${token}`)).toMatch(/^Linked\./);
    expect(chatsOf(s.db)).toEqual([{ account_id: "acc", chat_id: "100" }]);
    expect(s.cmd(`/start ${token}`, "200")).toMatch(/expired or was already used/);
    const late = (await s.post("/api/telegram/link-token", s.account("late"))).json<TelegramLinkResponse>().token;
    expect(s.cmd(`/start ${late}`, "300", nowSec + 601)).toMatch(/expired/);
    expect(s.cmd("/start not-a-real-token", "400")).toMatch(/expired/);
    expect(s.cmd("/start <script>", "400")).toMatch(/expired/);
    expect(chatsOf(s.db)).toEqual([{ account_id: "acc", chat_id: "100" }]);
  });

  it("a chat belongs to one account; linking it with another account's token moves it", async () => {
    const s = setup();
    const a = (await s.post("/api/telegram/link-token", s.account("a"))).json<TelegramLinkResponse>().token;
    const b = (await s.post("/api/telegram/link-token", s.account("b"))).json<TelegramLinkResponse>().token;
    s.cmd(`/start ${a}`, "100");
    s.cmd(`/start ${b}`, "100");
    expect(chatsOf(s.db)).toEqual([{ account_id: "b", chat_id: "100" }]);
  });

  it("unlink removes the chat; /me shows telegramLinked", async () => {
    const s = setup();
    const cookie = s.account("acc");
    const { token } = (await s.post("/api/telegram/link-token", cookie)).json<TelegramLinkResponse>();
    s.cmd(`/start ${token}`);
    expect(s.db.prepare("SELECT count(*) AS n FROM telegram_chats").get()).toEqual({ n: 1 });
    expect((await s.post("/api/telegram/unlink", cookie)).status).toBe(200);
    expect(s.db.prepare("SELECT count(*) AS n FROM telegram_chats").get()).toEqual({ n: 0 });
  });
});

describe("bot commands (BRAND.md voice)", () => {
  const linked = async () => {
    const s = setup();
    const { token } = (await s.post("/api/telegram/link-token", s.account("acc"))).json<TelegramLinkResponse>();
    s.cmd(`/start ${token}`);
    return s;
  };

  it("/start without a token explains how to link", () => {
    expect(setup().cmd("/start")).toContain(`open ${TEST_ORIGIN}`);
  });

  it("/status lists watched loans with numbers, a stranded loan's BCH to claim, and the Paryon link", async () => {
    const s = await linked();
    expect(s.cmd("/status")).toMatch(/not watching any loan yet/);
    insertWatch(s.db, { id: "w1", accountId: "acc", loanId: LOAN, rules: { liquidation: true, loanGone: true }, createdAt: 1 });
    insertWatch(s.db, { id: "w2", accountId: "acc", loanId: STRANDED.id, rules: { liquidation: true, loanGone: true }, createdAt: 2 });
    insertWatch(s.db, { id: "w3", accountId: "acc", loanId: "ef".repeat(32), rules: { liquidation: true, loanGone: true }, createdAt: 3 });
    const out = s.cmd("/status");
    expect(out).toContain("Your watched loans (BCH $200.00):");
    expect(out).toContain(`${LOAN.slice(0, 8)}: 20.0% from liquidation, liquidation price $160.00`);
    expect(out).toContain(`${STRANDED.id.slice(0, 8)}: repaid, 3.5000 BCH left to claim in the Paryon app`);
    expect(out).toContain("efefefef: no longer open");
    expect(out).toContain("https://paryonusd.com/app");
  });

  it("/status fits Telegram's limit", async () => {
    const s = await linked();
    for (let i = 0; i < 200; i++) insertWatch(s.db, { id: `w${i}`, accountId: "acc", loanId: LOAN + i, rules: { liquidation: true, loanGone: true }, createdAt: i });
    const out = s.cmd("/status");
    expect(out.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(out).toMatch(/and \d+ more/);
  });

  it("/mute and /unmute switch alerts off and on for the whole account", async () => {
    const s = await linked();
    expect(s.cmd("/mute")).toMatch(/muted/);
    expect(s.db.prepare("SELECT muted FROM accounts WHERE id = 'acc'").get()).toEqual({ muted: 1 });
    expect(s.cmd("/status")).toMatch(/Alerts are muted/);
    expect(s.cmd("/unmute")).toMatch(/on again/);
    expect(s.db.prepare("SELECT muted FROM accounts WHERE id = 'acc'").get()).toEqual({ muted: 0 });
  });

  it("unlinked chats are told how to link; unknown commands and plain text point to /help", () => {
    const s = setup();
    for (const c of ["/status", "/mute", "/unmute"]) expect(s.cmd(c, "999")).toMatch(/not linked yet/);
    expect(s.cmd("/nope")).toMatch(/Send \/help/);
    expect(s.cmd("hello")).toMatch(/Send \/help/);
    expect(s.cmd("/help")).toBe(HELP);
  });

  it("no reply contains an emoji", async () => {
    const s = await linked();
    insertWatch(s.db, { id: "w1", accountId: "acc", loanId: LOAN, rules: { liquidation: true, loanGone: true }, createdAt: 1 });
    for (const c of ["/start", "/status", "/mute", "/unmute", "/help", "/nope", "hi"]) {
      expect(s.cmd(c)).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
  });
});

describe("link → watch → alert, end to end", () => {
  it("a linked account with a watch gets the message in its chat when the loan crosses a band", async () => {
    const s = setup();
    const cookie = s.account("acc");
    const { token } = (await s.post("/api/telegram/link-token", cookie)).json<TelegramLinkResponse>();
    s.cmd(`/start ${token}`, "777");
    insertWatch(s.db, { id: "w1", accountId: "acc", loanId: LOAN, rules: { liquidation: true, loanGone: true }, createdAt: 1 });
    const sent: Array<[string, string]> = [];
    const runner = createAlertRunner({ db: s.db, now: () => NOW, log: () => {}, sendMessage: async (c, t) => void sent.push([c, t]) });
    await runner.onUpdate(null, stateOf([loanAt(LOAN, 0.3)])); // first look: safe, silent
    await runner.onUpdate(null, stateOf([loanAt(LOAN, 0.07)])); // critical
    expect(sent).toEqual([["777", expect.stringContaining("is 7% from liquidation")]]);
  });
});
