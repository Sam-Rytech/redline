import {
  binToHex,
  decodeHdPublicKey,
  encodeDataPush,
  encodeHdPublicKey,
  flattenBinArray,
  hexToBin,
  sha256,
  utf8ToBin,
  type TransactionCommon,
} from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { encodeLoginOpReturn } from "../src/index.js";
import {
  ChallengeError,
  CHALLENGE_TTL_SECONDS,
  createChallenge,
  verifyLogin,
  type SourceOutput,
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
const ctx = { domain: DOMAIN, now: NOW, randomBytes };
const baseReq = { xpubReceive: wallet.xpubReceive, xpubChange: wallet.xpubChange, outpoint: OUTPOINT, path: ["receive", 0] as ["receive", number] };

function setup(
  opts: {
    pathIndex?: number;
    source?: "missing" | SourceOutput;
    challengeDomain?: string;
    /** replace the stored challenge (e.g. a forged/legacy row) */
    forge?: (c: StoredChallenge) => StoredChallenge;
  } = {},
) {
  const index = opts.pathIndex ?? 0;
  const made = createChallenge({ ...baseReq, path: ["receive", index] }, { ...ctx, domain: opts.challengeDomain ?? DOMAIN });
  const ch = opts.forge ? opts.forge(made.challenge) : made.challenge;
  const store = new Map<string, StoredChallenge>([[ch.nonceHex, ch]]);
  const state = {
    now: NOW,
    spentOk: true,
    raceLost: false,
    spentQueries: [] as Array<{ txid: string }>,
    sourceQueries: 0,
  };
  const defaultSource: SourceOutput = { lockingBytecode: wallet.lockingBytecode("receive", index), valueSatoshis: 10_000n };
  const deps: VerifyDeps = {
    domain: DOMAIN,
    bindingToken: made.bindingToken,
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
      return opts.source ?? defaultSource;
    },
    async isUnspentOrSpentBy(_op, txid) {
      state.spentQueries.push({ txid });
      return state.spentOk;
    },
  };
  const tx = (o: Partial<LoginTxOptions> = {}) =>
    makeLoginTx({ wallet, path: ["receive", index], outpoint: OUTPOINT, domain: DOMAIN, nonceHex: ch.nonceHex, expiry: ch.expiry, ...o });
  return { ch, bindingToken: made.bindingToken, store, state, deps, tx };
}

const expectFail = async (p: ReturnType<typeof verifyLogin>, code: string) => {
  const r = await p;
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe(code);
};

const expectChallengeError = (f: () => unknown, code: string) => {
  try {
    f();
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(ChallengeError);
    expect((e as ChallengeError).code).toBe(code);
  }
};

const setOutput = (i: number, f: (o: TransactionCommon["outputs"][number]) => TransactionCommon["outputs"][number]) =>
  (tx: TransactionCommon): TransactionCommon => ({ ...tx, outputs: tx.outputs.map((o, j) => (j === i ? f(o) : o)) });

describe("createChallenge", () => {
  it("stores nonce, expiry = now + 300, binding hash and the inputs", () => {
    const { ch, bindingToken } = setup();
    expect(CHALLENGE_TTL_SECONDS).toBe(300);
    expect(ch.nonceHex).toMatch(/^[0-9a-f]{32}$/);
    expect(bindingToken).toMatch(/^[0-9a-f]{64}$/);
    expect(bindingToken).not.toContain(ch.nonceHex);
    expect(ch.bindingHash).toBe(binToHex(sha256.hash(utf8ToBin(bindingToken))));
    expect(ch.expiry).toBe(NOW + 300);
    expect(ch).toMatchObject({ domain: DOMAIN, outpoint: OUTPOINT, path: ["receive", 0], usedAt: null });
  });

  it("rejects bad xpubs with bad_xpub (invalid, testnet, receive === change)", () => {
    const decoded = decodeHdPublicKey(wallet.xpubReceive);
    if (typeof decoded === "string") throw new Error(decoded);
    const tpub = encodeHdPublicKey({ network: "testnet", node: decoded.node }).hdPublicKey;
    for (const bad of [
      { ...baseReq, xpubReceive: "xpubnope" },
      { ...baseReq, xpubChange: "" },
      { ...baseReq, xpubReceive: tpub },
      { ...baseReq, xpubChange: wallet.xpubReceive },
    ]) {
      expectChallengeError(() => createChallenge(bad, ctx), "bad_xpub");
    }
  });

  it("only the receive path may sign in (bad_path)", () => {
    for (const path of [["change", 0], ["defi", 0]]) {
      expectChallengeError(() => createChallenge({ ...baseReq, path: path as ["receive", number] }, ctx), "bad_path");
    }
  });

  it("PoC: victim receive xpub + attacker change xpub on the change path is refused", () => {
    expectChallengeError(
      () =>
        createChallenge(
          { xpubReceive: wallet.xpubReceive, xpubChange: other.xpubChange, outpoint: OUTPOINT, path: ["change", 0] as unknown as ["receive", number] },
          ctx,
        ),
      "bad_path",
    );
  });

  it("rejects bad indices and outpoints with bad_request", () => {
    const bads: unknown[] = [
      { ...baseReq, path: ["receive", 1000] },
      { ...baseReq, path: ["receive", -1] },
      { ...baseReq, path: ["receive", 1.5] },
      { ...baseReq, path: "receive" },
      { ...baseReq, outpoint: { txid: "abc", vout: 0 } },
      { ...baseReq, outpoint: { txid: FUNDING_TXID, vout: -1 } },
    ];
    for (const bad of bads) expectChallengeError(() => createChallenge(bad as typeof baseReq, ctx), "bad_request");
    expect(() => createChallenge({ ...baseReq, path: ["receive", 999] }, ctx)).not.toThrow();
  });
});

describe("verifyLogin", () => {
  it("happy path: ok, accountId = sha256(xpubReceive), nonce marked used", async () => {
    const { deps, tx, store, ch, state } = setup();
    const r = await verifyLogin(tx().hex, deps);
    const expected = binToHex(sha256.hash(utf8ToBin(wallet.xpubReceive)));
    expect(r).toEqual({ ok: true, accountId: expected, xpubReceive: wallet.xpubReceive, xpubChange: wallet.xpubChange });
    expect(store.get(ch.nonceHex)!.usedAt).toBe(NOW);
    expect(state.spentQueries[0]!.txid).toMatch(/^[0-9a-f]{64}$/);

    const s2 = setup();
    const r2 = await verifyLogin(s2.tx().hex, s2.deps);
    expect(r2.ok && r2.accountId).toBe(expected);
  });

  it("works for receive index 7 and with a DER ECDSA signature", async () => {
    const a = setup({ pathIndex: 7 });
    expect((await verifyLogin(a.tx().hex, a.deps)).ok).toBe(true);
    const b = setup();
    expect((await verifyLogin(b.tx({ ecdsa: true }).hex, b.deps)).ok).toBe(true);
  });

  it("works at the expiry second", async () => {
    const { deps, tx, state, ch } = setup();
    state.now = ch.expiry;
    expect((await verifyLogin(tx().hex, deps)).ok).toBe(true);
  });

  it("PoC: a (forged/legacy) change-path challenge never proves the victim's receive xpub", async () => {
    // attacker signs with their own change-0 coin; challenge row claims victim receive + attacker change
    const attackerLock = other.lockingBytecode("change", 0);
    const s = setup({
      source: { lockingBytecode: attackerLock, valueSatoshis: 10_000n },
      forge: (c) => ({ ...c, xpubChange: other.xpubChange, path: ["change", 0] as unknown as ["receive", number] }),
    });
    const t = makeLoginTx({ wallet: other, path: ["change", 0], outpoint: OUTPOINT, domain: DOMAIN, nonceHex: s.ch.nonceHex, expiry: s.ch.expiry });
    const r = await verifyLogin(t.hex, s.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("wrong_address");
  });

  describe("challenge binding", () => {
    it("challenge_not_bound without the binding token", async () => {
      const { deps, tx } = setup();
      await expectFail(verifyLogin(tx().hex, { ...deps, bindingToken: null }), "challenge_not_bound");
    });
    it("challenge_not_bound with another browser's token", async () => {
      const { deps, tx } = setup();
      const otherToken = setup().bindingToken;
      await expectFail(verifyLogin(tx().hex, { ...deps, bindingToken: otherToken }), "challenge_not_bound");
    });
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
    it("version != 2", async () => {
      const { deps, tx } = setup();
      await expectFail(verifyLogin(tx({ mutateBeforeSign: (x) => ({ ...x, version: 1 }) }).hex, deps), "bad_tx");
    });
    it("locktime != 0", async () => {
      const { deps, tx } = setup();
      await expectFail(verifyLogin(tx({ mutateBeforeSign: (x) => ({ ...x, locktime: 5 }) }).hex, deps), "bad_tx");
    });
    it("non-final sequence", async () => {
      const { deps, tx } = setup();
      const t = tx({ mutateBeforeSign: (x) => ({ ...x, inputs: x.inputs.map((i) => ({ ...i, sequenceNumber: 0xfffffffe })) }) });
      await expectFail(verifyLogin(t.hex, deps), "bad_tx");
    });
    it("OP_RETURN output value != 0", async () => {
      const { deps, tx } = setup();
      await expectFail(verifyLogin(tx({ mutateBeforeSign: setOutput(0, (o) => ({ ...o, valueSatoshis: 1n })) }).hex, deps), "bad_tx");
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

  it("expired (time passed, OP_RETURN expiry differs, or stored domain differs)", async () => {
    const a = setup();
    a.state.now = a.ch.expiry + 1;
    await expectFail(verifyLogin(a.tx().hex, a.deps), "expired");
    const b = setup();
    await expectFail(verifyLogin(b.tx({ expiry: b.ch.expiry + 600 }).hex, b.deps), "expired");
    const c = setup({ challengeDomain: "old.redline.test" });
    await expectFail(verifyLogin(c.tx().hex, c.deps), "expired");
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

  it("token_source: the spent output carries tokens", async () => {
    const lock = wallet.lockingBytecode("receive", 0);
    const source: SourceOutput = { lockingBytecode: lock, valueSatoshis: 10_000n, token: { amount: 5n, category: hexToBin("44".repeat(32)) } };
    const { deps, tx } = setup({ source });
    await expectFail(verifyLogin(tx().hex, deps), "token_source");
  });

  it("source_too_small: source below MIN_LOGIN_UTXO_SATS", async () => {
    const lock = wallet.lockingBytecode("receive", 0);
    const { deps, tx } = setup({ source: { lockingBytecode: lock, valueSatoshis: 1_999n } });
    // build against 2000 (helper refuses less), then the chain says 1999
    const t = tx({ sourceValueSats: 2_000n, mutateBeforeSign: setOutput(1, (o) => ({ ...o, valueSatoshis: 1_599n })) });
    await expectFail(verifyLogin(t.hex, deps), "source_too_small");
  });

  it("wrong_address: source output belongs to a different key", async () => {
    const s = setup({ source: { lockingBytecode: other.lockingBytecode("receive", 0), valueSatoshis: 10_000n } });
    const t = makeLoginTx({ wallet: other, outpoint: OUTPOINT, domain: DOMAIN, nonceHex: s.ch.nonceHex, expiry: s.ch.expiry });
    await expectFail(verifyLogin(t.hex, s.deps), "wrong_address");
  });

  it("wrong_address: right key but different index than the challenge path", async () => {
    const s = setup({ source: { lockingBytecode: wallet.lockingBytecode("receive", 1), valueSatoshis: 10_000n } });
    const t = makeLoginTx({ wallet, path: ["receive", 1], outpoint: OUTPOINT, domain: DOMAIN, nonceHex: s.ch.nonceHex, expiry: s.ch.expiry });
    await expectFail(verifyLogin(t.hex, s.deps), "wrong_address");
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

  describe("bad_signature", () => {
    it("signed by a different key", async () => {
      const { deps, tx } = setup();
      await expectFail(verifyLogin(tx({ signWith: other.privateKey("receive", 0) }).hex, deps), "bad_signature");
    });

    it("tx mutated after signing", async () => {
      const { deps, tx } = setup();
      const t = tx({ mutateAfterSign: setOutput(1, (o) => ({ ...o, valueSatoshis: o.valueSatoshis - 1n })) });
      await expectFail(verifyLogin(t.hex, deps), "bad_signature");
    });

    it("client lied about the source value (server uses chain value)", async () => {
      const { deps, tx } = setup();
      const t = tx({ sourceValueSats: 9_000n, mutateBeforeSign: setOutput(1, (o) => ({ ...o, valueSatoshis: 9_600n })) });
      await expectFail(verifyLogin(t.hex, deps), "bad_signature");
    });

    it("unsigned tx", async () => {
      const { deps, tx } = setup();
      const t = tx({ mutateAfterSign: (x) => ({ ...x, inputs: x.inputs.map((i) => ({ ...i, unlockingBytecode: new Uint8Array() })) }) });
      await expectFail(verifyLogin(t.hex, deps), "bad_signature");
    });

    // VM-valid but not covering everything: must be refused (PoC: 0x42 sig reusable across nonces)
    for (const [name, sighash] of [["NONE|FORKID 0x42", 0x42], ["SINGLE|FORKID 0x43", 0x43], ["ALL|ANYONECANPAY|FORKID 0xc1", 0xc1]] as const) {
      it(`non-covering sighash ${name} (Schnorr and ECDSA)`, async () => {
        for (const ecdsa of [false, true]) {
          const { deps, tx } = setup();
          await expectFail(verifyLogin(tx({ sighash, ecdsa }).hex, deps), "bad_signature");
        }
      });
    }

    it("extra pushes in the unlocking bytecode", async () => {
      for (const where of ["before", "after"] as const) {
        const { deps, tx } = setup();
        const t = tx({
          mutateAfterSign: (x) => ({
            ...x,
            inputs: x.inputs.map((i) => ({
              ...i,
              unlockingBytecode: flattenBinArray(
                where === "before" ? [encodeDataPush(Uint8Array.of(0xaa)), i.unlockingBytecode] : [i.unlockingBytecode, encodeDataPush(Uint8Array.of(0xaa))],
              ),
            })),
          }),
        });
        await expectFail(verifyLogin(t.hex, deps), "bad_signature");
      }
    });
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
});
