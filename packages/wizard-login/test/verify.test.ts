import { binToHex, hexToBin, sha256, utf8ToBin, type TransactionCommon } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { encodeLoginOpReturn } from "../src/index.js";
import {
  ChallengeError,
  CHALLENGE_TTL_SECONDS,
  createChallenge,
  verifyLogin,
  type StoredChallenge,
  type VerifyDeps,
} from "../src/server/index.js";
import { FUNDING_TXID, makeLoginTx, makeWallet, type LoginTxOptions } from "./helpers.js";

const DOMAIN = "redline.test";
const NOW = 1_795_000_000;
const wallet = makeWallet(1);
const other = makeWallet(2);
const OUTPOINT = { txid: FUNDING_TXID, vout: 1 };

let counter = 0;
const randomBytes = (n: number) => new Uint8Array(n).fill(++counter);

function setup(opts: { path?: ["receive" | "change", number]; source?: "default" | "missing" | { lockingBytecode: Uint8Array; valueSatoshis: bigint } } = {}) {
  const path = opts.path ?? ["receive", 0];
  const ch = createChallenge(
    { xpubReceive: wallet.xpubReceive, xpubChange: wallet.xpubChange, outpoint: OUTPOINT, path },
    { domain: DOMAIN, now: NOW, randomBytes },
  );
  const store = new Map<string, StoredChallenge>([[ch.nonceHex, ch]]);
  const state = {
    now: NOW,
    spentOk: true,
    raceLost: false,
    spentQueries: [] as Array<{ txid: string }>,
    sourceQueries: 0,
  };
  const defaultSource = { lockingBytecode: wallet.lockingBytecode(path[0], path[1]), valueSatoshis: 10_000n };
  const deps: VerifyDeps = {
    domain: DOMAIN,
    now: () => state.now,
    async getChallenge(nonce) {
      const c = store.get(nonce);
      return c ? { ...c } : null;
    },
    async markChallengeUsed(nonce, now) {
      const c = store.get(nonce);
      if (!c || c.usedAt !== null || state.raceLost) return false;
      c.usedAt = now;
      return true;
    },
    async getSourceOutput(op) {
      state.sourceQueries++;
      if (op.txid !== OUTPOINT.txid || op.vout !== OUTPOINT.vout) return null;
      if (opts.source === "missing") return null;
      return opts.source && opts.source !== "default" ? opts.source : defaultSource;
    },
    async isUnspentOrSpentBy(_op, txid) {
      state.spentQueries.push({ txid });
      return state.spentOk;
    },
  };
  const tx = (o: Partial<LoginTxOptions> = {}) =>
    makeLoginTx({ wallet, path, outpoint: OUTPOINT, domain: DOMAIN, nonceHex: ch.nonceHex, expiry: ch.expiry, ...o });
  return { ch, store, state, deps, tx };
}

const expectFail = async (p: ReturnType<typeof verifyLogin>, code: string) => {
  const r = await p;
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe(code);
};

const setOutput = (i: number, f: (o: TransactionCommon["outputs"][number]) => TransactionCommon["outputs"][number]) =>
  (tx: TransactionCommon): TransactionCommon => ({ ...tx, outputs: tx.outputs.map((o, j) => (j === i ? f(o) : o)) });

describe("createChallenge", () => {
  it("stores nonce, expiry = now + 300 and the inputs", () => {
    const { ch } = setup();
    expect(CHALLENGE_TTL_SECONDS).toBe(300);
    expect(ch.nonceHex).toMatch(/^[0-9a-f]{32}$/);
    expect(ch.expiry).toBe(NOW + 300);
    expect(ch).toMatchObject({ domain: DOMAIN, outpoint: OUTPOINT, path: ["receive", 0], usedAt: null });
  });

  it("rejects bad xpubs with bad_xpub", () => {
    const ctx = { domain: DOMAIN, now: NOW, randomBytes };
    const base = { xpubReceive: wallet.xpubReceive, xpubChange: wallet.xpubChange, outpoint: OUTPOINT, path: ["receive", 0] as ["receive", number] };
    for (const bad of [{ ...base, xpubReceive: "xpubnope" }, { ...base, xpubChange: "" }]) {
      try {
        createChallenge(bad, ctx);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ChallengeError);
        expect((e as ChallengeError).code).toBe("bad_xpub");
      }
    }
  });

  it("rejects bad paths and outpoints with bad_request", () => {
    const ctx = { domain: DOMAIN, now: NOW, randomBytes };
    const base = { xpubReceive: wallet.xpubReceive, xpubChange: wallet.xpubChange, outpoint: OUTPOINT, path: ["receive", 0] as ["receive", number] };
    const bads: unknown[] = [
      { ...base, path: ["defi", 0] },
      { ...base, path: ["receive", 1000] },
      { ...base, path: ["receive", -1] },
      { ...base, path: ["receive", 1.5] },
      { ...base, outpoint: { txid: "abc", vout: 0 } },
      { ...base, outpoint: { txid: FUNDING_TXID, vout: -1 } },
    ];
    for (const bad of bads) {
      expect(() => createChallenge(bad as typeof base, ctx)).toThrowError(expect.objectContaining({ code: "bad_request" }));
    }
    expect(() => createChallenge({ ...base, path: ["change", 999] }, ctx)).not.toThrow();
  });
});

describe("verifyLogin", () => {
  it("happy path: ok, accountId = sha256(xpubReceive), nonce marked used", async () => {
    const { deps, tx, store, ch, state } = setup();
    const t = tx();
    const r = await verifyLogin(t.hex, deps);
    const expected = binToHex(sha256.hash(utf8ToBin(wallet.xpubReceive)));
    expect(r).toEqual({ ok: true, accountId: expected, xpubReceive: wallet.xpubReceive, xpubChange: wallet.xpubChange });
    expect(store.get(ch.nonceHex)!.usedAt).toBe(NOW);
    // spent check is asked about the login tx's own txid
    expect(state.spentQueries[0]!.txid).toMatch(/^[0-9a-f]{64}$/);

    // stable for the same xpub on a second login
    const s2 = setup();
    const r2 = await verifyLogin(s2.tx().hex, s2.deps);
    expect(r2.ok && r2.accountId).toBe(expected);
  });

  it("works for a change-path address", async () => {
    const { deps, tx } = setup({ path: ["change", 7] });
    expect((await verifyLogin(tx().hex, deps)).ok).toBe(true);
  });

  it("works at the expiry second", async () => {
    const { deps, tx, state, ch } = setup();
    state.now = ch.expiry;
    expect((await verifyLogin(tx().hex, deps)).ok).toBe(true);
  });

  describe("bad_tx", () => {
    it("not hex / not a tx", async () => {
      const { deps } = setup();
      await expectFail(verifyLogin("zz", deps), "bad_tx");
      await expectFail(verifyLogin("", deps), "bad_tx");
      await expectFail(verifyLogin("0200000000", deps), "bad_tx");
    });
    it("wrong output count", async () => {
      const { deps, tx } = setup();
      const t = tx({ mutateBeforeSign: (x) => ({ ...x, outputs: [...x.outputs, x.outputs[1]!] }) });
      await expectFail(verifyLogin(t.hex, deps), "bad_tx");
    });
    it("output 0 is not a login OP_RETURN", async () => {
      const { deps, tx } = setup();
      const t = tx({ mutateBeforeSign: setOutput(0, (o) => ({ ...o, lockingBytecode: hexToBin("6a0401020304") })) });
      await expectFail(verifyLogin(t.hex, deps), "bad_tx");
    });
    it("tokens on an output", async () => {
      const { deps, tx } = setup();
      const t = tx({
        mutateBeforeSign: setOutput(1, (o) => ({ ...o, token: { amount: 1n, category: hexToBin("33".repeat(32)) } })),
      });
      await expectFail(verifyLogin(t.hex, deps), "bad_tx");
    });
  });

  it("bad_domain", async () => {
    const { deps, tx } = setup();
    await expectFail(verifyLogin(tx({ domain: "evil.example" }).hex, deps), "bad_domain");
  });

  it("unknown_nonce", async () => {
    const { deps, tx } = setup();
    await expectFail(verifyLogin(tx({ nonceHex: "ff".repeat(16) }).hex, deps), "unknown_nonce");
  });

  it("outpoint_mismatch", async () => {
    const { deps, tx } = setup();
    await expectFail(verifyLogin(tx({ outpoint: { txid: FUNDING_TXID, vout: 2 } }).hex, deps), "outpoint_mismatch");
  });

  it("expired (time passed, or OP_RETURN expiry differs from stored)", async () => {
    const a = setup();
    a.state.now = a.ch.expiry + 1;
    await expectFail(verifyLogin(a.tx().hex, a.deps), "expired");
    const b = setup();
    await expectFail(verifyLogin(b.tx({ expiry: b.ch.expiry + 600 }).hex, b.deps), "expired");
  });

  it("nonce_used (reused tx)", async () => {
    const { deps, tx } = setup();
    const t = tx();
    expect((await verifyLogin(t.hex, deps)).ok).toBe(true);
    await expectFail(verifyLogin(t.hex, deps), "nonce_used");
  });

  it("source_missing", async () => {
    const { deps, tx } = setup({ source: "missing" });
    await expectFail(verifyLogin(tx().hex, deps), "source_missing");
  });

  it("wrong_address: source output belongs to a different key", async () => {
    const otherSource = { lockingBytecode: other.lockingBytecode("receive", 0), valueSatoshis: 10_000n };
    const { deps } = setup({ source: otherSource });
    // the other wallet signs a perfectly valid tx for its own coin, against our challenge
    const s = setup();
    const t = makeLoginTx({ wallet: other, outpoint: OUTPOINT, domain: DOMAIN, nonceHex: s.ch.nonceHex, expiry: s.ch.expiry });
    deps.getChallenge = s.deps.getChallenge;
    await expectFail(verifyLogin(t.hex, deps), "wrong_address");
  });

  it("wrong_address: right key but different index than the challenge path", async () => {
    const { deps } = setup({ source: { lockingBytecode: wallet.lockingBytecode("receive", 1), valueSatoshis: 10_000n } });
    const s = setup();
    deps.getChallenge = s.deps.getChallenge;
    const t = makeLoginTx({ wallet, path: ["receive", 1], outpoint: OUTPOINT, domain: DOMAIN, nonceHex: s.ch.nonceHex, expiry: s.ch.expiry });
    await expectFail(verifyLogin(t.hex, deps), "wrong_address");
  });

  it("wrong_address: output 1 pays somewhere else", async () => {
    const { deps, tx } = setup();
    const t = tx({ mutateBeforeSign: setOutput(1, (o) => ({ ...o, lockingBytecode: other.lockingBytecode("receive", 0) })) });
    await expectFail(verifyLogin(t.hex, deps), "wrong_address");
  });

  it("bad_fee: 100 and 5000", async () => {
    for (const fee of [100n, 5000n]) {
      const { deps, tx } = setup();
      const t = tx({ mutateBeforeSign: setOutput(1, (o) => ({ ...o, valueSatoshis: 10_000n - fee })) });
      await expectFail(verifyLogin(t.hex, deps), "bad_fee");
    }
    for (const fee of [200n, 2000n]) {
      const { deps, tx } = setup();
      const t = tx({ mutateBeforeSign: setOutput(1, (o) => ({ ...o, valueSatoshis: 10_000n - fee })) });
      expect((await verifyLogin(t.hex, deps)).ok).toBe(true);
    }
  });

  it("bad_signature: signed by a different key", async () => {
    const { deps, tx } = setup();
    await expectFail(verifyLogin(tx({ signWith: other.privateKey("receive", 0) }).hex, deps), "bad_signature");
  });

  it("bad_signature: tx mutated after signing", async () => {
    const { deps, tx } = setup();
    const t = tx({ mutateAfterSign: setOutput(1, (o) => ({ ...o, valueSatoshis: o.valueSatoshis - 1n })) });
    await expectFail(verifyLogin(t.hex, deps), "bad_signature");
  });

  it("bad_signature: client lied about the source value (server uses chain value)", async () => {
    // wallet signs over a source value of 9000 but chain says 10000 → sighash differs
    const { deps, tx } = setup();
    const t = tx({ sourceValueSats: 9_000n, mutateBeforeSign: setOutput(1, (o) => ({ ...o, valueSatoshis: 9_600n })) });
    await expectFail(verifyLogin(t.hex, deps), "bad_signature");
  });

  it("bad_signature: unsigned tx", async () => {
    const { deps, tx } = setup();
    const t = tx({ mutateAfterSign: (x) => ({ ...x, inputs: x.inputs.map((i) => ({ ...i, unlockingBytecode: new Uint8Array() })) }) });
    await expectFail(verifyLogin(t.hex, deps), "bad_signature");
  });

  it("spent elsewhere", async () => {
    const { deps, tx, state, store, ch } = setup();
    state.spentOk = false;
    await expectFail(verifyLogin(tx().hex, deps), "spent");
    expect(store.get(ch.nonceHex)!.usedAt).toBeNull();
  });

  it("nonce_used when markChallengeUsed loses a race", async () => {
    const { deps, tx, state } = setup();
    state.raceLost = true;
    await expectFail(verifyLogin(tx().hex, deps), "nonce_used");
  });

  it("checks in order: domain before nonce lookup, nonce before chain fetch", async () => {
    const { deps, tx, state } = setup();
    await expectFail(verifyLogin(tx({ domain: "x", nonceHex: "ee".repeat(16) }).hex, deps), "bad_domain");
    await expectFail(verifyLogin(tx({ nonceHex: "ee".repeat(16) }).hex, deps), "unknown_nonce");
    expect(state.sourceQueries).toBe(0);
  });

  it("OP_RETURN in output 1 position is not accepted", async () => {
    const { deps, tx, ch } = setup();
    const op = encodeLoginOpReturn({ domain: DOMAIN, nonceHex: ch.nonceHex, expiry: ch.expiry });
    const t = tx({
      mutateBeforeSign: (x) => ({ ...x, outputs: [x.outputs[1]!, { lockingBytecode: op, valueSatoshis: 0n }] }),
    });
    await expectFail(verifyLogin(t.hex, deps), "bad_tx");
  });
});
