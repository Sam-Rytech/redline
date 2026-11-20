import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";

const ch = (nonceHex: string, expiry: number) => ({
  nonceHex,
  expiry,
  domain: "localhost",
  outpoint: { txid: "ab".repeat(32), vout: 2 },
  path: ["receive", 4] as ["receive", number],
  xpubReceive: "xr",
  xpubChange: "xc",
  bindingHash: "bb".repeat(32),
  usedAt: null,
});

describe("db", () => {
  it("stores and reads challenges", () => {
    const db = openDb(":memory:");
    db.insertChallenge(ch("n1", 100));
    expect(db.getChallenge("n1")).toEqual(ch("n1", 100));
    expect(db.getChallenge("nope")).toBeNull();
  });

  it("markChallengeUsed is single-use", () => {
    const db = openDb(":memory:");
    db.insertChallenge(ch("n1", 100));
    expect(db.markChallengeUsed("n1", 50)).toBe(true);
    expect(db.markChallengeUsed("n1", 51)).toBe(false);
    expect(db.markChallengeUsed("missing", 51)).toBe(false);
    expect(db.getChallenge("n1")!.usedAt).toBe(50);
  });

  it("purges expired challenges and sessions", () => {
    const db = openDb(":memory:");
    db.insertChallenge(ch("old", 10));
    db.insertChallenge(ch("new", 1000));
    db.createSession("s-old", "acc", 10);
    db.createSession("s-new", "acc", 1000);
    db.purgeExpired(500);
    expect(db.getChallenge("old")).toBeNull();
    expect(db.getChallenge("new")).not.toBeNull();
    expect(db.getSession("s-old", 5)).toBeNull();
    expect(db.getSession("s-new", 500)).toEqual({ accountId: "acc" });
  });

  it("sessions expire and can be deleted", () => {
    const db = openDb(":memory:");
    db.createSession("s", "acc", 100);
    expect(db.getSession("s", 100)).toBeNull();
    expect(db.getSession("s", 99)).toEqual({ accountId: "acc" });
    db.deleteSession("s");
    expect(db.getSession("s", 1)).toBeNull();
  });

  it("upsertAccount keeps created_at and pro_until", () => {
    const db = openDb(":memory:");
    db.upsertAccount({ id: "a", xpubReceive: "r1", xpubChange: "c1", now: 1 });
    db.setProUntil("a", 99);
    db.upsertAccount({ id: "a", xpubReceive: "r1", xpubChange: "c2", now: 5 });
    expect(db.getAccount("a")).toEqual({ id: "a", xpubReceive: "r1", xpubChange: "c2", createdAt: 1, proUntil: 99 });
    expect(db.getAccount("b")).toBeNull();
  });

  it("upsertAccount never overwrites xpub_receive", () => {
    const db = openDb(":memory:");
    db.upsertAccount({ id: "a", xpubReceive: "r1", xpubChange: "c1", now: 1 });
    expect(() => db.upsertAccount({ id: "a", xpubReceive: "EVIL", xpubChange: "c2", now: 2 })).toThrow();
    expect(db.getAccount("a")).toMatchObject({ xpubReceive: "r1", xpubChange: "c1" });
  });

  it("ignores legacy non-receive challenge rows", () => {
    const db = openDb(":memory:");
    db.insertChallenge({ ...ch("n1", 100), path: ["change", 0] as unknown as ["receive", number] });
    expect(db.getChallenge("n1")).toBeNull();
  });

  describe("watches", () => {
    const w = (id: string, accountId: string, loanId: string) => ({
      id, accountId, loanId, rules: { liquidation: true, loanGone: false }, createdAt: 10,
    });

    it("insert, list, count, get; duplicate (account, loan) refused", () => {
      const db = openDb(":memory:");
      expect(db.insertWatch(w("w1", "acc", "loan1"))).toBe(true);
      expect(db.insertWatch(w("w2", "acc", "loan1"))).toBe(false);
      expect(db.insertWatch(w("w3", "other", "loan1"))).toBe(true);
      expect(db.countWatches("acc")).toBe(1);
      expect(db.listWatches("acc")).toEqual([
        { id: "w1", accountId: "acc", loanId: "loan1", rules: { liquidation: true, loanGone: false }, lastBand: null, mutedUntil: null, createdAt: 10 },
      ]);
      expect(db.getWatch("w3")!.accountId).toBe("other");
      expect(db.getWatch("nope")).toBeNull();
      expect(db.allWatches().map((x) => x.id).sort()).toEqual(["w1", "w3"]);
    });

    it("update rules and delete only for the owner", () => {
      const db = openDb(":memory:");
      db.insertWatch(w("w1", "acc", "loan1"));
      expect(db.updateWatchRules("w1", "intruder", { liquidation: false, loanGone: false })).toBe(false);
      expect(db.updateWatchRules("w1", "acc", { liquidation: false, loanGone: true })).toBe(true);
      expect(db.getWatch("w1")!.rules).toEqual({ liquidation: false, loanGone: true });
      expect(db.deleteWatch("w1", "intruder")).toBe(false);
      expect(db.deleteWatch("w1", "acc")).toBe(true);
      expect(db.getWatch("w1")).toBeNull();
    });

    it("setWatchBand", () => {
      const db = openDb(":memory:");
      db.insertWatch(w("w1", "acc", "loan1"));
      db.setWatchBand("w1", "danger");
      expect(db.getWatch("w1")!.lastBand).toBe("danger");
      db.setWatchBand("w1", null);
      expect(db.getWatch("w1")!.lastBand).toBeNull();
    });
  });

  describe("telegram", () => {
    it("link tokens are single use and expire", () => {
      const db = openDb(":memory:");
      db.insertLinkToken("h1", "acc", 100, 700);
      db.insertLinkToken("h2", "acc", 100, 700);
      expect(db.consumeLinkToken("h1", 700)).toBeNull(); // expires_at <= now
      expect(db.consumeLinkToken("h2", 699)).toBe("acc");
      expect(db.consumeLinkToken("h2", 699)).toBeNull(); // used
      expect(db.consumeLinkToken("missing", 1)).toBeNull();
    });

    it("purgeExpired drops expired link tokens", () => {
      const db = openDb(":memory:");
      db.insertLinkToken("h1", "acc", 100, 700);
      db.purgeExpired(800);
      expect(db.consumeLinkToken("h1", 0)).toBeNull();
    });

    it("chats: link, relink, one account per chat, mute, unlink", () => {
      const db = openDb(":memory:");
      expect(db.getTelegramChat("acc")).toBeNull();
      db.linkTelegramChat("acc", "111", 5);
      expect(db.getTelegramChat("acc")).toEqual({ accountId: "acc", chatId: "111", linkedAt: 5, mutedUntil: null });
      expect(db.accountForChat("111")).toBe("acc");
      db.linkTelegramChat("acc", "222", 6); // account moves to another chat
      expect(db.accountForChat("111")).toBeNull();
      expect(db.accountForChat("222")).toBe("acc");
      db.linkTelegramChat("other", "222", 7); // the chat now follows the other account
      expect(db.getTelegramChat("acc")).toBeNull();
      expect(db.accountForChat("222")).toBe("other");
      db.setChatMute("222", 1000);
      expect(db.getTelegramChat("other")!.mutedUntil).toBe(1000);
      db.setChatMute("222", null);
      expect(db.getTelegramChat("other")!.mutedUntil).toBeNull();
      expect(db.unlinkTelegram("other")).toBe(true);
      expect(db.unlinkTelegram("other")).toBe(false);
    });

    it("records sent alerts", () => {
      const db = openDb(":memory:");
      db.recordAlert("w1", "liquidation", "danger", 50);
      expect(db.alertsFor("w1")).toEqual([{ watchId: "w1", rule: "liquidation", value: "danger", sentAt: 50 }]);
    });
  });

  describe("invoices", () => {
    const inv = (id: string, accountId = "acc", createdAt = 100) => ({
      id, accountId, asset: "BCH" as const, amountSats: 62_500, merchantLockingHex: "76a914" + "22".repeat(20) + "88ac",
      inputs: [{ txid: "ab".repeat(32), vout: 1 }, { txid: "cd".repeat(32), vout: 0 }], createdAt, expiresAt: createdAt + 1800,
    });

    it("insert, get, list newest first; expire only an open one", () => {
      const db = openDb(":memory:");
      db.insertInvoice(inv("i1"));
      db.insertInvoice(inv("i2", "acc", 200));
      db.insertInvoice(inv("i3", "other"));
      expect(db.getInvoice("i1")).toEqual({ ...inv("i1"), txid: null, status: "open", paidAt: null });
      expect(db.getInvoice("nope")).toBeNull();
      expect(db.listInvoices("acc").map((r) => r.id)).toEqual(["i2", "i1"]);
      expect(db.expireInvoice("i1")).toBe(true);
      expect(db.expireInvoice("i1")).toBe(false);
      expect(db.getInvoice("i1")!.status).toBe("expired");
    });

    it("markInvoicePaid is once-only and stacks Pro from max(paidAt, pro_until)", () => {
      const db = openDb(":memory:");
      db.upsertAccount({ id: "acc", xpubReceive: "xr", xpubChange: "xc", now: 1 });
      db.insertInvoice(inv("i1"));
      db.insertInvoice(inv("i2"));
      expect(db.markInvoicePaid("i1", "ee".repeat(32), 1000, 30)).toBe(true);
      expect(db.getAccount("acc")!.proUntil).toBe(1030);
      expect(db.getInvoice("i1")).toMatchObject({ status: "paid", txid: "ee".repeat(32), paidAt: 1000 });
      // second time: no change, Pro not extended again
      expect(db.markInvoicePaid("i1", "ee".repeat(32), 1005, 30)).toBe(false);
      expect(db.getAccount("acc")!.proUntil).toBe(1030);
      // another invoice paid while Pro is still running stacks on pro_until
      db.expireInvoice("i2"); // an expired invoice can still be marked paid (the money is on chain)
      expect(db.markInvoicePaid("i2", "ff".repeat(32), 1010, 30)).toBe(true);
      expect(db.getAccount("acc")!.proUntil).toBe(1060);
      // the same txid cannot pay two invoices
      db.insertInvoice(inv("i3"));
      expect(() => db.markInvoicePaid("i3", "ff".repeat(32), 1020, 30)).toThrow();
      expect(db.getInvoice("i3")!.status).toBe("open");
      expect(db.getAccount("acc")!.proUntil).toBe(1060);
    });

    it("Pro starts from paidAt when pro_until is in the past", () => {
      const db = openDb(":memory:");
      db.upsertAccount({ id: "acc", xpubReceive: "xr", xpubChange: "xc", now: 1 });
      db.setProUntil("acc", 500);
      db.insertInvoice(inv("i1"));
      expect(db.markInvoicePaid("i1", "ee".repeat(32), 1000, 30)).toBe(true);
      expect(db.getAccount("acc")!.proUntil).toBe(1030);
    });
  });
});
