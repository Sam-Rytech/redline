// In-memory BCH chain for payment tests: coins, a mempool that spends them, per-script history,
// and a broadcast that behaves like a node (already known / inputs spent / accepted).
import { binToHex, decodeTransaction, hashTransaction, hexToBin } from "@bitauth/libauth";
import type { Outpoint } from "@redline/api-types";
import type { SourceOutput } from "@redline/wizard-login/server";
import type { BroadcastResult, PaymentChain } from "../src/electrum.js";

const key = (o: Outpoint) => `${o.txid}:${o.vout}`;

export function fakePaymentChain() {
  const coins = new Map<string, { output: SourceOutput; spentBy: string | null }>();
  const txs = new Map<string, Uint8Array>();
  const history = new Map<string, string[]>();
  const broadcasts: string[] = [];
  const calls: string[] = [];
  /** override the node's answer for the next broadcasts (return undefined to fall through) */
  let onBroadcast: ((hex: string) => BroadcastResult | undefined) | null = null;
  let down = false;

  /** a confirmed coin; returns its outpoint */
  const addCoin = (op: Outpoint, lockingBytecode: Uint8Array, valueSatoshis: bigint, token?: SourceOutput["token"]) => {
    coins.set(key(op), { output: { lockingBytecode, valueSatoshis, ...(token && { token }) }, spentBy: null });
    return op;
  };

  /** the transaction enters the mempool: spends its inputs, creates outputs, shows in history */
  const accept = (bin: Uint8Array): string => {
    const tx = decodeTransaction(bin);
    if (typeof tx === "string") throw new Error(tx);
    const txid = hashTransaction(bin);
    txs.set(txid, bin);
    for (const i of tx.inputs) {
      const c = coins.get(key({ txid: binToHex(i.outpointTransactionHash), vout: i.outpointIndex }));
      if (c) c.spentBy = txid;
    }
    tx.outputs.forEach((o, vout) => {
      coins.set(key({ txid, vout }), { output: { lockingBytecode: o.lockingBytecode, valueSatoshis: o.valueSatoshis }, spentBy: null });
      const h = binToHex(o.lockingBytecode);
      const list = history.get(h) ?? [];
      if (!list.includes(txid)) list.push(txid);
      history.set(h, list);
    });
    return txid;
  };

  const guard = (what: string) => {
    calls.push(what);
    if (down) throw new Error("connect ECONNREFUSED");
  };

  const chain: PaymentChain = {
    async getOutputs(ops) {
      guard("getOutputs");
      return ops.map((o) => {
        const c = coins.get(key(o));
        return c ? { output: c.output, unspent: c.spentBy === null } : null;
      });
    },
    async broadcast(hex) {
      guard("broadcast");
      broadcasts.push(hex);
      const forced = onBroadcast?.(hex);
      if (forced) return forced;
      const bin = hexToBin(hex);
      const tx = decodeTransaction(bin);
      if (typeof tx === "string") return { ok: false, message: "TX decode failed" };
      const txid = hashTransaction(bin);
      if (txs.has(txid)) return { ok: false, message: "the transaction was rejected by network rules.\n\ntxn-already-known" };
      for (const i of tx.inputs) {
        const c = coins.get(key({ txid: binToHex(i.outpointTransactionHash), vout: i.outpointIndex }));
        if (!c) return { ok: false, message: "the transaction was rejected by network rules.\n\nMissing inputs" };
        if (c.spentBy) return { ok: false, message: "the transaction was rejected by network rules.\n\ntxn-mempool-conflict (code 18)" };
      }
      accept(bin);
      return { ok: true };
    },
    async getTransaction(txid) {
      guard("getTransaction");
      return txs.get(txid) ?? null;
    },
    async recentTransactions(lockingBytecode, limit) {
      guard("recentTransactions");
      const ids = [...(history.get(binToHex(lockingBytecode)) ?? [])].reverse().slice(0, limit);
      return ids.map((id) => txs.get(id)!);
    },
  };

  return {
    chain,
    coins,
    txs,
    broadcasts,
    calls,
    addCoin,
    accept,
    setBroadcast: (f: typeof onBroadcast) => (onBroadcast = f),
    setDown: (d: boolean) => (down = d),
  };
}
