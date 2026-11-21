// Browser half of WizardConnect sign-in: pick a coin, get a challenge, have the wallet sign
// (never broadcast) the login transaction, and exchange it for a session cookie.
// Pure: only `fetch` (injectable) and the wallet manager are used; no WizardConnect runtime import.
import {
  decodeHdPublicKey,
  deriveHdPublicNodeChild,
  encodeLockingBytecodeP2pkh,
  hash160,
  hashTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
  type Input,
  type Output,
} from "@bitauth/libauth";
import type { ApiError, ChallengeRequest, ChallengeResponse, MeResponse, Utxo, VerifyRequest } from "@redline/api-types";
import type { DappConnectionManager } from "@wizardconnect/dapp";
import { MIN_LOGIN_UTXO_SATS, buildUnsignedLoginTx } from "../protocol.js";

export type LoginErrorCode = "no_paths" | "no_funds" | "wallet_rejected" | "server_rejected" | "network";

export class LoginError extends Error {
  /** HTTP status, when the error came from a server response */
  status?: number;
  /** the server's `error.code`, for server_rejected */
  serverCode?: string;
  /** receive address 0 (for no_funds: where to send a coin) */
  address?: string;

  constructor(
    readonly code: LoginErrorCode,
    message: string,
    extra: { status?: number; serverCode?: string; address?: string; cause?: unknown } = {},
  ) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined);
    this.name = "LoginError";
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.serverCode !== undefined) this.serverCode = extra.serverCode;
    if (extra.address !== undefined) this.address = extra.address;
  }
}

export type LoginStep = "addresses" | "utxos" | "challenge" | "signing" | "verifying";

/** The slice of DappConnectionManager wizardLogin uses (a real manager satisfies it). */
export type LoginWallet = Pick<DappConnectionManager, "getSessionPaths" | "signTransaction"> & { walletName?: string | null };

export interface WizardLoginOptions {
  manager: LoginWallet;
  /** default "/api" */
  apiBase?: string;
  signal?: AbortSignal;
  onStep?: (step: LoginStep, detail?: string) => void;
  /** called with the wallet's signed (not broadcast) login tx hex, before it is sent to the server */
  onSigned?: (signedTxHex: string) => void;
  /** default globalThis.fetch */
  fetch?: typeof globalThis.fetch;
}

/** Receive addresses the client looks at (Selene scans ~20 ahead). */
export const LOGIN_ADDRESS_COUNT = 20;
export const LOGIN_USER_PROMPT = "Sign in to Redline — this will NOT be sent";

/** P2PKH locking bytecode of child `index` of a chain xpub. Throws on an invalid xpub. */
function p2pkhAt(xpub: string, index: number): Uint8Array {
  const decoded = decodeHdPublicKey(xpub);
  if (typeof decoded === "string") throw new Error(`Invalid xpub: ${decoded}`);
  const child = deriveHdPublicNodeChild(decoded.node, index, { throwErrors: false });
  if (typeof child === "string") throw new Error(`Cannot derive xpub child ${index}: ${child}`);
  return encodeLockingBytecodeP2pkh(hash160(child.publicKey));
}

/** P2PKH `bitcoincash:` addresses for children start..start+count-1 of a chain xpub (e.g. m/44'/145'/0'/0). */
export function deriveAddresses(xpub: string, count: number, start = 0): string[] {
  const out: string[] = [];
  for (let i = start; i < start + count; i++) {
    const r = lockingBytecodeToCashAddress({ bytecode: p2pkhAt(xpub, i), prefix: "bitcoincash" });
    if (typeof r === "string") throw new Error(r);
    out.push(r.address);
  }
  return out;
}

/** Smallest token-free UTXO with at least MIN_LOGIN_UTXO_SATS (ties: txid, then vout), or null. */
export function pickLoginUtxo(utxos: readonly Utxo[]): Utxo | null {
  let best: Utxo | null = null;
  for (const u of utxos) {
    if (u.token !== null || !Number.isSafeInteger(u.satoshis) || u.satoshis < MIN_LOGIN_UTXO_SATS) continue;
    if (
      !best ||
      u.satoshis < best.satoshis ||
      (u.satoshis === best.satoshis && (u.txid < best.txid || (u.txid === best.txid && u.vout < best.vout)))
    ) {
      best = u;
    }
  }
  return best;
}

/** Transaction id (display order) of a raw transaction hex. */
export const txidOf = (txHex: string): string => hashTransaction(hexToBin(txHex.toLowerCase()));

const isAbort = (e: unknown, signal?: AbortSignal) =>
  signal?.aborted === true || (e instanceof Error && e.name === "AbortError") || (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError");
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function wizardLogin(opts: WizardLoginOptions): Promise<MeResponse> {
  const { manager, signal, onStep } = opts;
  const apiBase = (opts.apiBase ?? "/api").replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  signal?.throwIfAborted();

  const api = async <T>(path: string, init: { method?: "GET" | "POST"; body?: unknown }): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(`${apiBase}${path}`, {
        method: init.method ?? "GET",
        credentials: "include",
        ...(init.body !== undefined && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
        ...(signal && { signal }),
      });
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      throw new LoginError("network", `Could not reach the server (${path}): ${messageOf(e)}`, { cause: e });
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      throw new LoginError("network", `Unexpected non-JSON response from ${path} (HTTP ${res.status})`, { status: res.status, cause: e });
    }
    if (!res.ok) {
      const err = (body as Partial<ApiError> | null)?.error;
      const code = typeof err?.code === "string" ? err.code : `http_${res.status}`;
      const msg = typeof err?.message === "string" ? err.message : res.statusText || "request failed";
      throw new LoginError("server_rejected", `${code}: ${msg}`, { status: res.status, serverCode: code });
    }
    return body as T;
  };

  // 1. xpubs + receive addresses
  onStep?.("addresses");
  const paths = manager.getSessionPaths();
  const xpubReceive = paths.find((p) => p.name === "receive")?.xpub;
  const xpubChange = paths.find((p) => p.name === "change")?.xpub;
  if (!xpubReceive || !xpubChange) {
    throw new LoginError("no_paths", "The wallet did not share its receive and change keys (xpubs). Reconnect the wallet and try again.");
  }
  let addresses: string[];
  try {
    addresses = deriveAddresses(xpubReceive, LOGIN_ADDRESS_COUNT);
    deriveAddresses(xpubChange, 1);
  } catch (e) {
    throw new LoginError("no_paths", `The wallet shared an unusable xpub: ${messageOf(e)}`, { cause: e });
  }
  const receive0 = addresses[0]!;

  // 2. coins on the receive path
  onStep?.("utxos", `${addresses.length} receive addresses`);
  const utxos = await api<Utxo[]>(`/utxos?addresses=${encodeURIComponent(addresses.join(","))}`, {});
  if (!Array.isArray(utxos)) throw new LoginError("network", "Unexpected /utxos response");
  const indexOf = new Map(addresses.map((a, i) => [a, i]));
  const coin = pickLoginUtxo(utxos.filter((u) => indexOf.has(u.address)));
  if (!coin) {
    throw new LoginError(
      "no_funds",
      `Send at least 2,000 sats (a fraction of a cent) to one of your wallet's receive addresses, then try again — sign-in needs a plain BCH coin there. Your first receive address: ${receive0}`,
      { address: receive0 },
    );
  }
  const index = indexOf.get(coin.address)!;
  const outpoint = { txid: coin.txid, vout: coin.vout };

  // 3. challenge (sets the HttpOnly rl_ch cookie that verify needs; the age screen must have passed)
  onStep?.("challenge", `coin ${coin.txid}:${coin.vout} (${coin.satoshis} sats) at receive/${index}`);
  const challengeBody: ChallengeRequest = { outpoint, path: ["receive", index] };
  const ch = await api<ChallengeResponse>("/auth/challenge", { method: "POST", body: challengeBody });

  // 4. build + sign (not broadcast)
  const sourceLockingBytecode = p2pkhAt(xpubReceive, index);
  const sourceValueSats = BigInt(coin.satoshis);
  const transaction = buildUnsignedLoginTx({
    outpoint,
    sourceLockingBytecode,
    sourceValueSats,
    domain: ch.domain,
    nonceHex: ch.nonce,
    expiry: ch.expiry,
  });
  const input0 = transaction.inputs[0]!;
  const sourceOutput: Input & Output = { ...input0, lockingBytecode: sourceLockingBytecode, valueSatoshis: sourceValueSats };
  onStep?.("signing", manager.walletName ? `approve in ${manager.walletName}` : "approve in your wallet");
  let signedTxHex: string;
  try {
    const res = await manager.signTransaction(
      {
        transaction: { transaction, sourceOutputs: [sourceOutput], broadcast: false, userPrompt: LOGIN_USER_PROMPT },
        // input order is final: one input
        inputPaths: [[0, "receive", index]],
      },
      signal ? { signal } : undefined,
    );
    if (res.error) throw new Error(res.error);
    signedTxHex = typeof res.signedTransaction === "string" ? res.signedTransaction.trim().toLowerCase() : "";
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    throw new LoginError("wallet_rejected", `The wallet did not sign: ${messageOf(e)}`, { cause: e });
  }
  if (!/^(?:[0-9a-f]{2})+$/.test(signedTxHex)) {
    throw new LoginError("wallet_rejected", "The wallet returned no signed transaction");
  }
  opts.onSigned?.(signedTxHex);

  // 5. verify → session cookie
  onStep?.("verifying", `txid ${txidOf(signedTxHex)}`);
  const verifyBody: VerifyRequest = { signedTxHex, xpubReceive, xpubChange };
  return api<MeResponse>("/auth/verify", { method: "POST", body: verifyBody });
}
