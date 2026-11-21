import { binToHex, decodeTransaction, encodeTransaction, hexToBin, utf8ToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import {
  LOGIN_FEE_SATS,
  MIN_LOGIN_UTXO_SATS,
  buildUnsignedLoginTx,
  decodeLoginOpReturn,
  encodeLoginOpReturn,
} from "../src/index.js";

const NONCE = "00112233445566778899aabbccddeeff";
const TXID = "f00d" + "11".repeat(28) + "beef";

describe("login OP_RETURN", () => {
  it("encodes 0x6a + 4 minimal pushes", () => {
    const b = encodeLoginOpReturn({ domain: "redline.app", nonceHex: NONCE, expiry: 0x01020304 });
    expect(binToHex(b)).toBe(
      "6a" + "04" + binToHex(utf8ToBin("WZL1")) + "0b" + binToHex(utf8ToBin("redline.app")) + "10" + NONCE + "04" + "04030201",
    );
  });

  it("round trips", () => {
    const v = { domain: "localhost", nonceHex: NONCE, expiry: 1_795_000_000 };
    expect(decodeLoginOpReturn(encodeLoginOpReturn(v))).toEqual(v);
  });

  it("rejects bad input on encode", () => {
    expect(() => encodeLoginOpReturn({ domain: "", nonceHex: NONCE, expiry: 1 })).toThrow();
    expect(() => encodeLoginOpReturn({ domain: "x", nonceHex: "abcd", expiry: 1 })).toThrow();
    expect(() => encodeLoginOpReturn({ domain: "x", nonceHex: NONCE, expiry: -1 })).toThrow();
    expect(() => encodeLoginOpReturn({ domain: "x", nonceHex: NONCE, expiry: 2 ** 32 })).toThrow();
  });

  it("decode returns null for anything else", () => {
    const good = encodeLoginOpReturn({ domain: "localhost", nonceHex: NONCE, expiry: 5 });
    expect(decodeLoginOpReturn(good.slice(1))).toBeNull(); // no OP_RETURN
    expect(decodeLoginOpReturn(good.slice(0, -1))).toBeNull(); // truncated
    expect(decodeLoginOpReturn(Uint8Array.of(...good, 0x51))).toBeNull(); // extra push
    const wrongMagic = Uint8Array.from(good);
    wrongMagic[5] = 0x32; // "WZL2"
    expect(decodeLoginOpReturn(wrongMagic)).toBeNull();
    // non-minimal push of the magic (OP_PUSHDATA1 0x04 ...)
    const nonMinimal = Uint8Array.of(0x6a, 0x4c, ...good.slice(1));
    expect(decodeLoginOpReturn(nonMinimal)).toBeNull();
    expect(decodeLoginOpReturn(hexToBin("6a"))).toBeNull();
    expect(decodeLoginOpReturn(new Uint8Array())).toBeNull();
  });
});

describe("buildUnsignedLoginTx", () => {
  const lock = hexToBin("76a914" + "22".repeat(20) + "88ac");
  const tx = buildUnsignedLoginTx({
    outpoint: { txid: TXID, vout: 3 },
    sourceLockingBytecode: lock,
    sourceValueSats: 5000n,
    domain: "localhost",
    nonceHex: NONCE,
    expiry: 1234,
  });

  it("has the documented structure", () => {
    expect(MIN_LOGIN_UTXO_SATS).toBe(2000);
    expect(LOGIN_FEE_SATS).toBe(400);
    expect(tx.version).toBe(2);
    expect(tx.locktime).toBe(0);
    expect(tx.inputs).toHaveLength(1);
    expect(tx.inputs[0]!.outpointIndex).toBe(3);
    expect(tx.inputs[0]!.sequenceNumber).toBe(0xffffffff);
    expect(tx.outputs).toHaveLength(2);
    expect(tx.outputs[0]!.valueSatoshis).toBe(0n);
    expect(decodeLoginOpReturn(tx.outputs[0]!.lockingBytecode)).toEqual({ domain: "localhost", nonceHex: NONCE, expiry: 1234 });
    expect(binToHex(tx.outputs[1]!.lockingBytecode)).toBe(binToHex(lock));
    expect(tx.outputs[1]!.valueSatoshis).toBe(5000n - BigInt(LOGIN_FEE_SATS));
    expect(tx.outputs.every((o) => o.token === undefined)).toBe(true);
  });

  it("uses display-order txids (reversed on the wire) and round trips", () => {
    const bin = encodeTransaction(tx);
    // version (4) + input count (1), then the outpoint hash in little-endian wire order
    expect(binToHex(bin.slice(5, 37))).toBe(binToHex(hexToBin(TXID).reverse()));
    const back = decodeTransaction(bin);
    if (typeof back === "string") throw new Error(back);
    expect(binToHex(back.inputs[0]!.outpointTransactionHash)).toBe(TXID);
  });

  it("refuses UTXOs below the minimum and bad txids", () => {
    const base = { outpoint: { txid: TXID, vout: 0 }, sourceLockingBytecode: lock, domain: "d", nonceHex: NONCE, expiry: 1 };
    expect(() => buildUnsignedLoginTx({ ...base, sourceValueSats: 1999n })).toThrow();
    expect(() => buildUnsignedLoginTx({ ...base, sourceValueSats: 2000 })).not.toThrow();
    expect(() => buildUnsignedLoginTx({ ...base, outpoint: { txid: "zz", vout: 0 }, sourceValueSats: 5000n })).toThrow();
  });
});
