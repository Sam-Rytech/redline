import { binToHex, encodeTransaction, hashTransaction, hexToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { createElectrumChain, type ProviderLike } from "../src/electrum.js";

const LOCK = hexToBin("76a914" + "22".repeat(20) + "88ac");
const fundingTx = encodeTransaction({
  version: 2,
  locktime: 0,
  inputs: [{ outpointTransactionHash: hexToBin("01".repeat(32)), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
  outputs: [
    { lockingBytecode: LOCK, valueSatoshis: 1234n },
    { lockingBytecode: LOCK, valueSatoshis: 5678n },
  ],
});
const FUND = hashTransaction(fundingTx);

function fake(o: { txs?: Record<string, string>; unspent?: Array<{ txid: string; vout: number }>; hang?: boolean; listunspent?: unknown } = {}) {
  const log = { connects: 0, disconnects: 0 };
  const provider = (): ProviderLike => ({
    async connect() {
      log.connects++;
      if (o.hang) await new Promise(() => {});
    },
    async disconnect() {
      log.disconnects++;
      return true;
    },
    async getRawTransaction(txid) {
      const hex = (o.txs ?? { [FUND]: binToHex(fundingTx) })[txid];
      if (!hex) throw new Error("No such mempool or blockchain transaction. Use gettransaction for wallet transactions.");
      return hex;
    },
    async getUtxosForLockingBytecode() {
      return o.unspent ?? [];
    },
    async performRequest() {
      return o.listunspent ?? [];
    },
  });
  return { provider, log };
}

describe("electrum chain", () => {
  it("getSourceOutput decodes the vout from the raw tx", async () => {
    const f = fake();
    const chain = createElectrumChain({ provider: f.provider });
    const out = await chain.getSourceOutput({ txid: FUND, vout: 1 });
    expect(out && binToHex(out.lockingBytecode)).toBe(binToHex(LOCK));
    expect(out?.valueSatoshis).toBe(5678n);
    expect(await chain.getSourceOutput({ txid: FUND, vout: 2 })).toBeNull();
    expect(await chain.getSourceOutput({ txid: "ab".repeat(32), vout: 0 })).toBeNull();
    expect(f.log.disconnects).toBe(f.log.connects);
  });

  it("rejects a raw tx that does not hash to the requested txid", async () => {
    const other = "cd".repeat(32);
    const chain = createElectrumChain({ provider: fake({ txs: { [other]: binToHex(fundingTx) } }).provider });
    await expect(chain.getSourceOutput({ txid: other, vout: 0 })).rejects.toThrow(/wrong txid/);
  });

  it("isUnspentOrSpentBy: unspent, spent by our tx, spent elsewhere", async () => {
    const login = "ee".repeat(32);
    const unspent = createElectrumChain({ provider: fake({ unspent: [{ txid: FUND, vout: 1 }] }).provider });
    expect(await unspent.isUnspentOrSpentBy({ txid: FUND, vout: 1 }, login)).toBe(true);
    const elsewhere = createElectrumChain({ provider: fake({ unspent: [{ txid: FUND, vout: 0 }] }).provider });
    expect(await elsewhere.isUnspentOrSpentBy({ txid: FUND, vout: 1 }, login)).toBe(false);
    // our login tx is known to the node → fine
    const loginTx = encodeTransaction({ version: 2, locktime: 0, inputs: [], outputs: [{ lockingBytecode: LOCK, valueSatoshis: 1n }] });
    const loginId = hashTransaction(loginTx);
    const broadcast = createElectrumChain({
      provider: fake({ txs: { [FUND]: binToHex(fundingTx), [loginId]: binToHex(loginTx) } }).provider,
    });
    expect(await broadcast.isUnspentOrSpentBy({ txid: FUND, vout: 1 }, loginId)).toBe(true);
  });

  it("getUtxos maps listunspent incl. tokens and height", async () => {
    const chain = createElectrumChain({
      provider: fake({
        listunspent: [
          { tx_hash: "aa".repeat(32), tx_pos: 1, value: 1000, height: 900000 },
          { tx_hash: "bb".repeat(32), tx_pos: 0, value: 800, height: 0, token_data: { category: "cc".repeat(32), amount: "0", nft: { capability: "minting", commitment: "" } } },
        ],
      }).provider,
    });
    expect(await chain.getUtxos(["bitcoincash:qx"])).toEqual([
      { txid: "aa".repeat(32), vout: 1, address: "bitcoincash:qx", satoshis: 1000, height: 900000, token: null },
      { txid: "bb".repeat(32), vout: 0, address: "bitcoincash:qx", satoshis: 800, height: 0, token: { category: "cc".repeat(32), amount: "0", nft: { capability: "minting", commitment: "" } } },
    ]);
  });

  it("times out and disconnects the hung provider", async () => {
    const f = fake({ hang: true });
    const chain = createElectrumChain({ provider: f.provider, timeoutMs: 20 });
    await expect(chain.getSourceOutput({ txid: FUND, vout: 0 })).rejects.toThrow(/timed out/);
    expect(f.log.disconnects).toBeGreaterThanOrEqual(1);
  });

  it("falls back to the next host when connect fails", async () => {
    const f = fake();
    const tried: string[] = [];
    const chain = createElectrumChain({
      hostnames: ["down.example", "up.example"],
      provider: (host) => {
        tried.push(host);
        const p = f.provider();
        return host === "down.example" ? { ...p, connect: async () => Promise.reject(new Error("ECONNREFUSED")) } : p;
      },
    });
    const out = await chain.getSourceOutput({ txid: FUND, vout: 1 });
    expect(out?.valueSatoshis).toBe(5678n);
    expect(tried).toEqual(["down.example", "up.example"]);
  });

  it("does not fall back on a request error after connecting", async () => {
    const tried: string[] = [];
    const chain = createElectrumChain({
      hostnames: ["a", "b"],
      provider: (host) => {
        tried.push(host);
        return { ...fake().provider(), getRawTransaction: async () => Promise.reject(new Error("server busy")) };
      },
    });
    await expect(chain.getSourceOutput({ txid: FUND, vout: 1 })).rejects.toThrow("server busy");
    expect(tried).toEqual(["a"]);
  });

  it("stops trying further hosts after the overall timeout", async () => {
    const tried: string[] = [];
    const chain = createElectrumChain({
      hostnames: ["a", "b", "c"],
      timeoutMs: 20,
      connectTimeoutMs: 15,
      provider: (host) => {
        tried.push(host);
        return fake({ hang: true }).provider();
      },
    });
    await expect(chain.getSourceOutput({ txid: FUND, vout: 0 })).rejects.toThrow(/timed out/);
    await new Promise((r) => setTimeout(r, 60));
    expect(tried).toEqual(["a", "b"]);
  });

  it("after a host stalls, the next call starts at the next host and keeps the one that worked", async () => {
    const tried: string[] = [];
    const chain = createElectrumChain({
      hostnames: ["a", "b", "c"],
      timeoutMs: 30,
      provider: (host) => {
        tried.push(host);
        const p = fake().provider();
        return host === "a" ? { ...p, getRawTransaction: () => new Promise<string>(() => {}) } : p;
      },
    });
    await expect(chain.getSourceOutput({ txid: FUND, vout: 1 })).rejects.toThrow(/timed out/);
    expect((await chain.getSourceOutput({ txid: FUND, vout: 1 }))?.valueSatoshis).toBe(5678n);
    await chain.getSourceOutput({ txid: FUND, vout: 1 });
    expect(tried).toEqual(["a", "b", "b"]);
  });
});
