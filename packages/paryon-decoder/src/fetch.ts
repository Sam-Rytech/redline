import { ElectrumNetworkProvider } from "cashscript";
import { PARYON_ADDRESSES } from "./addresses.js";
import { buildSnapshot, type ChainUtxo, type Snapshot } from "./snapshot.js";

/** Public Fulcrum servers (all verified answering Fulcrum 2.1.4 on wss :50004), tried in order. */
export const DEFAULT_ELECTRUM_HOSTS: readonly string[] = [
  "bch.imaginary.cash",
  "electrum.imaginary.cash",
  "bch.loping.net",
  "fulcrum.greyh.at",
  "electroncash.dk",
];

/** The host list to try: `first` (e.g. ELECTRUM_HOST) ahead of the defaults, without duplicates. */
export function electrumHosts(first?: string): string[] {
  const f = first?.trim();
  return f ? [f, ...DEFAULT_ELECTRUM_HOSTS.filter((h) => h !== f)] : [...DEFAULT_ELECTRUM_HOSTS];
}

export const CONNECT_TIMEOUT_MS = 5_000;

interface Connectable {
  connect(): Promise<void>;
  disconnect(): Promise<unknown>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Connect to the first host that answers. A host whose connect fails or exceeds connectTimeoutMs is
 * disconnected (best effort) and the next one is tried. Throws listing every host's error if all fail.
 */
export async function connectFirst<P extends Connectable>(
  hosts: readonly string[],
  make: (host: string) => P,
  opts: { connectTimeoutMs?: number; log?: (msg: string) => void; signal?: AbortSignal } = {},
): Promise<{ provider: P; host: string }> {
  if (hosts.length === 0) throw new Error("no Electrum hosts configured");
  const timeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const errors: string[] = [];
  for (const host of hosts) {
    if (opts.signal?.aborted) throw new Error("connect aborted");
    let provider: P | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      provider = make(host);
      const pending = provider.connect();
      pending.catch(() => {}); // a late failure after the timeout must not be unhandled
      await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`connect timed out after ${timeoutMs / 1000}s`)), timeoutMs);
        }),
      ]);
      if (opts.signal?.aborted) {
        provider.disconnect().catch(() => {});
        throw new Error("connect aborted");
      }
      return { provider, host };
    } catch (e) {
      errors.push(`${host}: ${message(e)}`);
      opts.log?.(`electrum ${host} unavailable (${message(e)}), trying next host`);
      if (provider) {
        // never wait on a hung socket; never mask the original error
        try {
          provider.disconnect().catch(() => {});
        } catch {
          // ignore
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`all Electrum hosts failed: ${errors.join("; ")}`);
}

/** The slice of cashscript's ElectrumNetworkProvider fetchSnapshot uses (fakeable in tests). */
export interface SnapshotProvider extends Connectable {
  getUtxos(address: string): Promise<
    Array<{
      txid: string;
      vout: number;
      satoshis: bigint;
      token?: {
        category: string;
        amount: bigint;
        nft?: { capability: "none" | "mutable" | "minting"; commitment: string };
      };
    }>
  >;
  getBlockHeight(): Promise<number>;
}

/**
 * Which host to try first. Starts at the last host that completed a full fetch; after a failure (or a
 * stall the caller gave up on) it moves past the host that failed, so a host that connects but never
 * answers cannot block every refresh.
 */
export function createHostRotation(hosts: readonly string[]) {
  let start = 0;
  return {
    /** all hosts, beginning at the current start */
    ordered: (): string[] => [...hosts.slice(start), ...hosts.slice(0, start)],
    succeeded(host: string): void {
      const i = hosts.indexOf(host);
      if (i >= 0) start = i;
    },
    /** `host` = the one that connected and then failed; undefined = none connected */
    failed(host: string | undefined): void {
      if (hosts.length === 0) return;
      const i = host === undefined ? -1 : hosts.indexOf(host);
      start = ((i >= 0 ? i : start) + 1) % hosts.length;
    },
  };
}

interface FetchOpts {
  /** legacy single host; ignored when `hostnames` is given */
  hostname?: string;
  /** tried in order on connection failure (default: DEFAULT_ELECTRUM_HOSTS) */
  hostnames?: string[];
  connectTimeoutMs?: number;
  log?: (msg: string) => void;
  /** for tests */
  provider?: (host: string) => SnapshotProvider;
}

const hostsOf = (opts: FetchOpts) => opts.hostnames ?? (opts.hostname ? [opts.hostname] : [...DEFAULT_ELECTRUM_HOSTS]);
const makerOf = (opts: FetchOpts) =>
  opts.provider ??
  ((hostname: string) =>
    new ElectrumNetworkProvider("mainnet", { hostname, manualConnectionManagement: true }) as unknown as SnapshotProvider);

/** one full fetch from the first host that connects; `onConnected` learns which host that was */
async function fetchFrom(hosts: string[], opts: FetchOpts, onConnected: (host: string) => void): Promise<Snapshot> {
  const { provider, host } = await connectFirst(hosts, makerOf(opts), {
    ...(opts.connectTimeoutMs !== undefined && { connectTimeoutMs: opts.connectTimeoutMs }),
    ...(opts.log && { log: opts.log }),
  });
  onConnected(host);
  try {
    const get = async (address: string): Promise<ChainUtxo[]> =>
      (await provider.getUtxos(address)).map((u) => ({
        txid: u.txid,
        vout: u.vout,
        satoshis: Number(u.satoshis),
        ...(u.token && {
          token: {
            category: u.token.category,
            amount: u.token.amount.toString(),
            ...(u.token.nft && { nft: { capability: u.token.nft.capability, commitment: u.token.nft.commitment } }),
          },
        }),
      }));
    const [loanUtxos, sidecarUtxos, priceUtxos, blockHeight] = await Promise.all([
      get(PARYON_ADDRESSES.loan),
      get(PARYON_ADDRESSES.loanSidecar),
      get(PARYON_ADDRESSES.price),
      provider.getBlockHeight(),
    ]);
    return buildSnapshot({ loanUtxos, sidecarUtxos, priceUtxos, blockHeight });
  } finally {
    try {
      await provider.disconnect();
    } catch {
      // never mask the original error
    }
  }
}

/** a single stateless fetch (hosts always tried in the given order) */
export async function fetchSnapshot(opts: FetchOpts = {}): Promise<Snapshot> {
  return fetchFrom(hostsOf(opts), opts, () => {});
}

/**
 * A stateful fetch for the chain reader: starts at the last host that completed a full fetch, and moves
 * to the next host after a failed refresh. A call that is still running when the next one starts (the
 * reader timed it out) counts as a failure of its host; its late result never moves the start back.
 */
export function createSnapshotFetcher(opts: FetchOpts = {}): () => Promise<Snapshot> {
  const rotation = createHostRotation(hostsOf(opts));
  let latest = 0;
  let running: { id: number; host: string | undefined } | null = null;
  return async () => {
    if (running) {
      opts.log?.(`electrum ${running.host ?? "connect"} stalled; starting the next refresh on another host`);
      rotation.failed(running.host);
    }
    const me = { id: ++latest, host: undefined as string | undefined };
    running = me;
    try {
      const snap = await fetchFrom(rotation.ordered(), opts, (h) => (me.host = h));
      if (me.id === latest && me.host !== undefined) rotation.succeeded(me.host);
      return snap;
    } catch (e) {
      if (me.id === latest) rotation.failed(me.host);
      throw e;
    } finally {
      if (running === me) running = null;
    }
  };
}
