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
});
