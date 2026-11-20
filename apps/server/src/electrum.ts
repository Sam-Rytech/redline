// Chain access for sign-in and wallet views. Everything security-relevant is read from
// Electrum here; nothing the client sends about UTXOs is trusted.
import { decodeTransaction, hashTransaction, hexToBin, lockingBytecodeToCashAddress } from "@bitauth/libauth";
import type { Utxo } from "@redline/api-types";
import type { LoginOutpoint, SourceOutput } from "@redline/wizard-login/server";
import { ElectrumNetworkProvider } from "cashscript";

export interface Chain {
  /** the output as recorded on chain, or null if the transaction / output does not exist */
  getSourceOutput(outpoint: LoginOutpoint): Promise<SourceOutput | null>;
  /** true when the outpoint is still unspent, or the transaction `txid` is known to the node */
  isUnspentOrSpentBy(outpoint: LoginOutpoint, txid: string): Promise<boolean>;
  getUtxos(addresses: string[]): Promise<Utxo[]>;
}

/** The slice of cashscript's ElectrumNetworkProvider we use (fakeable in tests). */
export interface ProviderLike {
  connect(): Promise<void>;
  disconnect(): Promise<unknown>;
  getRawTransaction(txid: string): Promise<string>;
  getUtxosForLockingBytecode(lockingBytecode: Uint8Array): Promise<Array<{ txid: string; vout: number }>>;
  performRequest(name: string, ...params: (string | number | boolean)[]): Promise<unknown>;
}

export const ELECTRUM_TIMEOUT_MS = 15_000;
const NOT_FOUND = /no such|not found|unknown transaction/i;

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => {}); // a late failure after the timeout must not be unhandled
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface ListUnspentItem {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
  token_data?: { category: string; amount: string; nft?: { capability: "none" | "mutable" | "minting"; commitment: string } };
}

const toUtxo = (address: string, u: ListUnspentItem): Utxo => ({
  txid: u.tx_hash,
  vout: u.tx_pos,
  address,
  satoshis: Number(u.value),
  height: Math.max(0, Number(u.height) || 0),
  token: u.token_data
    ? {
        category: u.token_data.category,
        amount: String(u.token_data.amount),
        nft: u.token_data.nft ? { capability: u.token_data.nft.capability, commitment: u.token_data.nft.commitment } : null,
      }
    : null,
});

export function createElectrumChain(
  opts: { hostname?: string; timeoutMs?: number; provider?: () => ProviderLike } = {},
): Chain {
  const timeoutMs = opts.timeoutMs ?? ELECTRUM_TIMEOUT_MS;
  const makeProvider =
    opts.provider ??
    (() =>
      new ElectrumNetworkProvider(
        "mainnet",
        opts.hostname ? { hostname: opts.hostname, manualConnectionManagement: true } : { manualConnectionManagement: true },
      ) as unknown as ProviderLike);

  async function run<T>(what: string, fn: (p: ProviderLike) => Promise<T>): Promise<T> {
    const p = makeProvider();
    const work = (async () => {
      await p.connect();
      try {
        return await fn(p);
      } finally {
        try {
          await p.disconnect();
        } catch {
          // never mask the original error
        }
      }
    })();
    return withTimeout(work, timeoutMs, what);
  }

  /** raw tx by id, verified to hash to that id; null when the node does not know it */
  async function rawTx(p: ProviderLike, txid: string): Promise<Uint8Array | null> {
    let hex: string;
    try {
      hex = await p.getRawTransaction(txid);
    } catch (e) {
      if (e instanceof Error && NOT_FOUND.test(e.message)) return null;
      throw e;
    }
    const bin = hexToBin(hex);
    if (hashTransaction(bin) !== txid) throw new Error("Electrum returned a transaction with the wrong txid");
    return bin;
  }

  async function sourceOutput(p: ProviderLike, op: LoginOutpoint): Promise<SourceOutput | null> {
    const bin = await rawTx(p, op.txid);
    if (!bin) return null;
    const tx = decodeTransaction(bin);
    if (typeof tx === "string") throw new Error(`Could not decode transaction ${op.txid}`);
    const out = tx.outputs[op.vout];
    if (!out) return null;
    return { lockingBytecode: out.lockingBytecode, valueSatoshis: out.valueSatoshis, ...(out.token && { token: out.token }) };
  }

  return {
    getSourceOutput: (op) => run("getSourceOutput", (p) => sourceOutput(p, op)),

    isUnspentOrSpentBy: (op, txid) =>
      run("isUnspentOrSpentBy", async (p) => {
        const src = await sourceOutput(p, op);
        if (src) {
          const utxos = await p.getUtxosForLockingBytecode(src.lockingBytecode);
          if (utxos.some((u) => u.txid === op.txid && u.vout === op.vout)) return true;
        }
        // our own login tx made it to the node (wallet broadcast it anyway)
        return (await rawTx(p, txid)) !== null;
      }),

    getUtxos: (addresses) =>
      run("getUtxos", async (p) => {
        const lists = await Promise.all(
          addresses.map(async (a) => {
            const res = (await p.performRequest("blockchain.address.listunspent", a, "include_tokens")) as ListUnspentItem[];
            if (!Array.isArray(res)) throw new Error("Unexpected listunspent response");
            return res.map((u) => toUtxo(a, u));
          }),
        );
        return lists.flat();
      }),
  };
}

/** mainnet P2PKH/P2SH cashaddr for a locking bytecode, or null */
export function addressFor(lockingBytecode: Uint8Array): string | null {
  const r = lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix: "bitcoincash" });
  return typeof r === "string" ? null : r.address;
}
