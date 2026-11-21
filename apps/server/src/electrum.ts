// Chain access for sign-in and wallet views. Everything security-relevant is read from
// Electrum here; nothing the client sends about UTXOs is trusted.
import { binToHex, decodeTransaction, hashTransaction, hexToBin, lockingBytecodeToCashAddress, sha256 } from "@bitauth/libauth";
import type { Outpoint, Utxo } from "@redline/api-types";
import { connectFirst, createHostRotation, DEFAULT_ELECTRUM_HOSTS } from "@redline/paryon-decoder";
import type { LoginOutpoint, SourceOutput } from "@redline/wizard-login/server";
import { ElectrumNetworkProvider } from "cashscript";

export interface Chain {
  /** the output as recorded on chain, or null if the transaction / output does not exist */
  getSourceOutput(outpoint: LoginOutpoint): Promise<SourceOutput | null>;
  /** true when the outpoint is still unspent, or the transaction `txid` is known to the node */
  isUnspentOrSpentBy(outpoint: LoginOutpoint, txid: string): Promise<boolean>;
  getUtxos(addresses: string[]): Promise<Utxo[]>;
}

export interface OutputState {
  output: SourceOutput;
  /** false once a transaction (confirmed or in the mempool) spends it */
  unspent: boolean;
}

/** ok: the node accepted it (txid = what the node answered, when it is a txid) */
export type BroadcastResult = { ok: true; txid?: string } | { ok: false; message: string };

/** Chain access for Pro pass payments. */
export interface PaymentChain {
  /** per outpoint (same order): the output and whether it is unspent; null when the tx/output does not exist */
  getOutputs(outpoints: Outpoint[]): Promise<Array<OutputState | null>>;
  /** per outpoint (same order): the output from its raw transaction, null when missing; no spent check */
  getSourceOutputs(outpoints: Outpoint[]): Promise<Array<SourceOutput | null>>;
  /** "txid:vout" of every unspent output on these locking scripts (deduped, one listunspent each) */
  unspentOutpoints(lockingBytecodes: Uint8Array[]): Promise<Set<string>>;
  /** blockchain.transaction.broadcast; a node rejection resolves { ok: false, message } (connection failures throw) */
  broadcast(txHex: string): Promise<BroadcastResult>;
  /** raw transaction (verified to hash to txid), null when the node does not know it */
  getTransaction(txid: string): Promise<Uint8Array | null>;
  /** up to `limit` transactions touching a locking bytecode: mempool first, then newest blocks */
  recentTransactions(lockingBytecode: Uint8Array, limit: number): Promise<Uint8Array[]>;
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
  opts: {
    /** legacy single host; ignored when `hostnames` is given */
    hostname?: string;
    /** tried in order when a connect fails (default: DEFAULT_ELECTRUM_HOSTS) */
    hostnames?: string[];
    timeoutMs?: number;
    connectTimeoutMs?: number;
    provider?: (host: string) => ProviderLike;
  } = {},
): Chain & PaymentChain {
  const timeoutMs = opts.timeoutMs ?? ELECTRUM_TIMEOUT_MS;
  const hosts = opts.hostnames ?? (opts.hostname ? [opts.hostname] : [...DEFAULT_ELECTRUM_HOSTS]);
  // start at the last host that answered; move past a host that failed or stalled
  const rotation = createHostRotation(hosts);
  const makeProvider =
    opts.provider ??
    ((hostname: string) =>
      new ElectrumNetworkProvider("mainnet", { hostname, manualConnectionManagement: true }) as unknown as ProviderLike);

  async function run<T>(what: string, fn: (p: ProviderLike) => Promise<T>): Promise<T> {
    let p: ProviderLike | undefined; // the provider currently connecting / connected
    let host: string | undefined; // the host that connected
    const abort = new AbortController();
    const work = (async () => {
      ({ provider: p, host } = await connectFirst(
        rotation.ordered(),
        (h) => (p = makeProvider(h)),
        {
          signal: abort.signal,
          ...(opts.connectTimeoutMs !== undefined && { connectTimeoutMs: opts.connectTimeoutMs }),
          log: (m) => console.log(m),
        },
      ));
      const connected = p;
      try {
        return await fn(connected);
      } finally {
        try {
          await connected.disconnect();
        } catch {
          // never mask the original error
        }
      }
    })();
    try {
      const result = await withTimeout(work, timeoutMs, what);
      if (host !== undefined) rotation.succeeded(host);
      return result;
    } catch (e) {
      abort.abort(); // stop trying further hosts
      rotation.failed(host);
      // a hung connect/request must not leak the socket: close it, best effort
      if (p && e instanceof Error && e.message.includes("timed out")) {
        try {
          await withTimeout(Promise.resolve(p.disconnect()), 2000, "disconnect");
        } catch {
          // ignore
        }
      }
      throw e;
    }
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

    getOutputs: (outpoints) =>
      run("getOutputs", async (p) => {
        const unspentByLock = new Map<string, Promise<Array<{ txid: string; vout: number }>>>();
        const out: Array<OutputState | null> = [];
        for (const op of outpoints) {
          const src = await sourceOutput(p, op);
          if (!src) {
            out.push(null);
            continue;
          }
          const key = binToHex(src.lockingBytecode);
          let list = unspentByLock.get(key);
          if (!list) unspentByLock.set(key, (list = p.getUtxosForLockingBytecode(src.lockingBytecode)));
          const unspent = (await list).some((u) => u.txid === op.txid && u.vout === op.vout);
          out.push({ output: src, unspent });
        }
        return out;
      }),

    getSourceOutputs: (outpoints) =>
      run("getSourceOutputs", async (p) => {
        const out: Array<SourceOutput | null> = [];
        for (const op of outpoints) out.push(await sourceOutput(p, op));
        return out;
      }),

    unspentOutpoints: (locks) =>
      run("unspentOutpoints", async (p) => {
        const unique = new Map(locks.map((l) => [binToHex(l), l]));
        const set = new Set<string>();
        for (const l of unique.values()) for (const u of await p.getUtxosForLockingBytecode(l)) set.add(`${u.txid}:${u.vout}`);
        return set;
      }),

    broadcast: (txHex) =>
      run("broadcast", async (p): Promise<BroadcastResult> => {
        try {
          const r = await p.performRequest("blockchain.transaction.broadcast", txHex);
          return typeof r === "string" && /^[0-9a-f]{64}$/i.test(r) ? { ok: true, txid: r.toLowerCase() } : { ok: true };
        } catch (e) {
          return { ok: false, message: e instanceof Error ? e.message : String(e) };
        }
      }),

    getTransaction: (txid) => run("getTransaction", (p) => rawTx(p, txid)),

    recentTransactions: (lockingBytecode, limit) =>
      run("recentTransactions", async (p) => {
        const scripthash = binToHex(sha256.hash(lockingBytecode).reverse());
        const history = (await p.performRequest("blockchain.scripthash.get_history", scripthash)) as Array<{ tx_hash: string; height: number }>;
        if (!Array.isArray(history)) throw new Error("Unexpected get_history response");
        // mempool entries have height 0 or -1
        const rank = (h: number) => (Number(h) > 0 ? Number(h) : Number.MAX_SAFE_INTEGER);
        const ids = [...history].sort((a, b) => rank(b.height) - rank(a.height)).slice(0, limit).map((h) => h.tx_hash);
        const txs = await Promise.all(ids.map((id) => rawTx(p, id)));
        return txs.filter((t): t is Uint8Array => t !== null);
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
