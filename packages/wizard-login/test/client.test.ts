import { decodeTransaction, encodeTransaction, hashTransaction, binToHex, lockingBytecodeToCashAddress } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import type { Utxo } from "@redline/api-types";
import { LoginError, deriveAddresses, pickLoginUtxo, txidOf } from "../src/client/login.js";
import { MIN_LOGIN_UTXO_SATS } from "../src/protocol.js";
import { makeLoginTx, makeWallet } from "./helpers.js";

const wallet = makeWallet(5);
const addressOf = (b: Uint8Array) => {
  const r = lockingBytecodeToCashAddress({ bytecode: b, prefix: "bitcoincash" });
  if (typeof r === "string") throw new Error(r);
  return r.address;
};

describe("deriveAddresses", () => {
  it("matches libauth HD derivation of the chain xpub (P2PKH, bitcoincash: prefix)", () => {
    const got = deriveAddresses(wallet.xpubReceive, 20);
    expect(got).toHaveLength(20);
    for (let i = 0; i < 20; i++) expect(got[i]).toBe(addressOf(wallet.lockingBytecode("receive", i)));
    expect(got[0]).toMatch(/^bitcoincash:q[0-9a-z]{41}$/);
    expect(deriveAddresses(wallet.xpubChange, 3)).toEqual([0, 1, 2].map((i) => addressOf(wallet.lockingBytecode("change", i))));
  });

  it("supports a start index", () => {
    expect(deriveAddresses(wallet.xpubReceive, 2, 7)).toEqual([7, 8].map((i) => addressOf(wallet.lockingBytecode("receive", i))));
  });

  it("throws on an invalid xpub", () => {
    expect(() => deriveAddresses("xpubnonsense", 1)).toThrow(/xpub/i);
  });
});

const u = (o: Partial<Utxo> & Pick<Utxo, "satoshis">): Utxo => ({
  txid: "aa".repeat(32),
  vout: 0,
  address: "bitcoincash:qtest",
  height: 1,
  token: null,
  ...o,
});
const token: Utxo["token"] = { category: "cc".repeat(32), amount: "0", nft: { capability: "none", commitment: "" } };

describe("pickLoginUtxo", () => {
  it("picks the smallest token-free UTXO of at least MIN_LOGIN_UTXO_SATS", () => {
    const list = [
      u({ satoshis: 50_000, vout: 1 }),
      u({ satoshis: 1_999, vout: 2 }),
      u({ satoshis: 2_500, vout: 3, token }),
      u({ satoshis: 9_000, vout: 4 }),
      u({ satoshis: MIN_LOGIN_UTXO_SATS, vout: 5 }),
    ];
    expect(pickLoginUtxo(list)?.vout).toBe(5);
  });

  it("returns null when nothing qualifies", () => {
    expect(pickLoginUtxo([])).toBeNull();
    expect(pickLoginUtxo([u({ satoshis: 1_000 }), u({ satoshis: 100_000, token })])).toBeNull();
  });

  it("is deterministic on ties (txid, then vout)", () => {
    const list = [u({ satoshis: 3_000, txid: "bb".repeat(32), vout: 0 }), u({ satoshis: 3_000, txid: "aa".repeat(32), vout: 9 }), u({ satoshis: 3_000, txid: "aa".repeat(32), vout: 2 })];
    expect(pickLoginUtxo(list)).toMatchObject({ txid: "aa".repeat(32), vout: 2 });
  });
});

describe("txidOf", () => {
  it("returns the display-order txid of a signed tx hex", () => {
    const t = makeLoginTx({ wallet, domain: "x.test", nonceHex: "00".repeat(16), expiry: 1 });
    const bin = encodeTransaction(t.tx);
    expect(txidOf(t.hex)).toBe(hashTransaction(bin));
    expect(txidOf(t.hex.toUpperCase())).toBe(hashTransaction(bin));
    expect(binToHex(encodeTransaction(decodeTransaction(bin) as never))).toBe(t.hex);
  });
});

describe("LoginError", () => {
  it("carries a code and is an Error", () => {
    const e = new LoginError("no_funds", "top up");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("LoginError");
    expect(e.code).toBe("no_funds");
    expect(e.message).toBe("top up");
  });
});
