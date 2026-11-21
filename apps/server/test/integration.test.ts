// End to end without network: sign-in session → watch via the API → link Telegram via /start →
// fake chain refreshes → alert runner → fake sendMessage.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TelegramLinkResponse, Watch } from "@redline/api-types";
import type { RawLoan, Snapshot } from "@redline/paryon-decoder";
import { createAlertRunner } from "../src/alerts.js";
import { createApp, SESSION_COOKIE } from "../src/app.js";
import { openDb } from "../src/db.js";
import type { Chain } from "../src/electrum.js";
import { createChainReader } from "../src/reader.js";
import { handleCommand } from "../src/telegram/commands.js";
import { tokenHash } from "../src/tokens.js";

const LOAN = "ab".repeat(32);
const OTHER = "cd".repeat(32);
const raw = (id: string, debtPusd: number): RawLoan => ({
  id, status: "mature", debtPusd, collateralSats: 10e8, interestRatePct: 1, nextInterestRatePct: 1, amountBeingRedeemedPusd: 0,
});
// price 200, 10 BCH: liq = debt / 10 * 1.1; distance = 1 - liq / 200
const debtFor = (distance: number) => ((1 - distance) * 200 * 10) / 1.1;
const snap = (loans: RawLoan[]): Snapshot => ({ priceUsd: 200, priceSequence: 1, blockHeight: 1, loans, skipped: 0 });
const noChain: Chain = { getSourceOutput: async () => null, isUnspentOrSpentBy: async () => false, getUtxos: async () => [] };

describe("reader update → alert runner → Telegram", () => {
  it("fires band alerts and loan-gone once each, respecting /mute", async () => {
    const NOW = new Date("2026-11-20T12:00:00.000Z");
    const nowS = NOW.getTime() / 1000;
    const db = openDb(":memory:");
    let loans: RawLoan[] = [raw(LOAN, debtFor(0.3)), raw(OTHER, debtFor(0.5))];
    const reader = createChainReader({ fetch: async () => snap(loans), now: () => NOW, log: () => {} });
    const sent: Array<{ chatId: string; text: string }> = [];
    const runner = createAlertRunner({ db, now: () => nowS, log: () => {}, sendMessage: async (chatId, text) => void sent.push({ chatId, text }) });
    let cycle: Promise<void> = Promise.resolve();
    reader.onUpdate((prev, next) => (cycle = runner.onUpdate(prev, next)));
    const refresh = async () => {
      await reader.refresh();
      await cycle;
    };
    await refresh();

    // a signed-in user watches the loan and links Telegram
    const app = createApp({
      reader, db, chain: noChain, now: () => NOW, botUsername: () => "RedlineBot",
      config: { loginDomain: "x", secureCookies: false, trustProxyHops: 0, logXff: false, publicOrigin: undefined },
    });
    db.upsertAccount({ id: "acc", xpubReceive: "xr", xpubChange: "xc", now: nowS });
    const session = randomBytes(32).toString("hex");
    db.createSession(tokenHash(session), "acc", nowS + 3600);
    const post = (path: string, body: unknown) =>
      app.request(path, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${session}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const w = (await (await post("/api/watches", { loanId: LOAN })).json()) as Watch;
    const link = (await (await post("/api/telegram/link-token", {})).json()) as TelegramLinkResponse;
    const tg = (text: string) => handleCommand({ text, chatId: "9001" }, { db, reader, now: () => nowS });
    expect(tg(`/start ${link.token}`)).toMatch(/^✅ Linked/);

    await refresh(); // first evaluation at 30%: safe, silent
    expect(sent).toEqual([]);
    expect(db.getWatch(w.id)!.lastBand).toBe("safe");

    loans = [raw(LOAN, debtFor(0.2)), raw(OTHER, debtFor(0.5))];
    await refresh();
    loans = [raw(LOAN, debtFor(0.19)), raw(OTHER, debtFor(0.5))];
    await refresh(); // still watch: no repeat
    expect(sent.map((m) => m.chatId)).toEqual(["9001"]);
    expect(sent[0]!.text).toMatch(/abababab entered the WATCH band/);

    expect(tg("/mute 1h")).toMatch(/muted until/);
    loans = [raw(LOAN, debtFor(0.1)), raw(OTHER, debtFor(0.5))];
    await refresh(); // danger while muted: suppressed, band advances
    expect(sent).toHaveLength(1);
    expect(db.getWatch(w.id)!.lastBand).toBe("danger");
    tg("/unmute");
    await refresh(); // no burst after unmuting
    expect(sent).toHaveLength(1);

    loans = [raw(LOAN, debtFor(0.05)), raw(OTHER, debtFor(0.5))];
    await refresh();
    expect(sent[1]!.text).toMatch(/CRITICAL/);

    loans = [raw(OTHER, debtFor(0.5))];
    await refresh();
    await refresh();
    expect(sent).toHaveLength(3);
    expect(sent[2]!.text).toMatch(/is gone/);
    expect(db.alertsFor(w.id).map((a) => a.value)).toEqual(["watch", "critical", "gone"]);
    expect(tg("/status")).toMatch(/abababab — loan closed/);
  });
});
