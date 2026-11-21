// Server half of WizardConnect sign-in. Framework-agnostic: all I/O is injected.
// Every chain fact (source output script + value, spent state) comes from `deps`, never the client.
//
// What a successful verify proves: the holder of the private key for address
// `xpubReceive/index` signed (SIGHASH_ALL) a transaction committing to our domain and a
// single-use nonce that was issued to the same browser (rl_ch cookie) less than 300 s ago.
// The xpubs arrive with the verify request (docs/DATABASE.md keeps them out of the challenge row);
// the receive xpub is proven by the signature, the change xpub is taken on trust.
import {
  binToHex,
  binsAreEqual,
  createVirtualMachineBCH,
  decodeAuthenticationInstructions,
  decodeHdPublicKey,
  decodeTransaction,
  deriveHdPublicNodeChild,
  encodeDataPush,
  encodeLockingBytecodeP2pkh,
  flattenBinArray,
  hash160,
  hashTransaction,
  hexToBin,
  sha256,
  utf8ToBin,
  type Output,
} from "@bitauth/libauth";
import { MAX_LOGIN_FEE_SATS, MIN_LOGIN_FEE_SATS, MIN_LOGIN_UTXO_SATS, NONCE_BYTES, decodeLoginOpReturn } from "../protocol.js";

export const CHALLENGE_TTL_SECONDS = 300;
export const MAX_PATH_INDEX = 999;
/** random bytes in the browser id held by the rl_ch cookie */
export const BROWSER_ID_BYTES = 32;
/** SIGHASH_ALL | SIGHASH_FORKID: the only accepted signature type (covers every input and output) */
export const SIGHASH_ALL_FORKID = 0x41;

export interface LoginOutpoint {
  txid: string;
  vout: number;
}

/** One row of the challenges table (docs/DATABASE.md). */
export interface StoredChallenge {
  nonceHex: string;
  /** sha256 (hex) of the rl_ch cookie value given to the browser that asked */
  browserIdHash: string;
  outpoint: LoginOutpoint;
  /** sign-in always proves the receive xpub */
  path: ["receive", number];
  domain: string;
  expiry: number;
  usedAt: number | null;
}

export interface VerifyInput {
  signedTxHex: string;
  xpubReceive: string;
  xpubChange: string;
}

/** A source output as fetched from the chain. `token` must be included when the output carries one. */
export type SourceOutput = Pick<Output, "lockingBytecode" | "valueSatoshis" | "token">;

export interface VerifyDeps {
  getChallenge(nonceHex: string): Promise<StoredChallenge | null>;
  /** Atomically mark used; false if it was already used. */
  markChallengeUsed(nonceHex: string, now: number): Promise<boolean>;
  /** From the chain (Electrum), never from the client. */
  getSourceOutput(outpoint: LoginOutpoint): Promise<SourceOutput | null>;
  isUnspentOrSpentBy(outpoint: LoginOutpoint, txid: string): Promise<boolean>;
  /** unix seconds */
  now(): number;
  domain: string;
  /** rl_ch cookie value presented by the browser calling verify */
  browserId: string | null;
}

/**
 * Failure codes. `challenge_mismatch`, `challenge_expired` and `challenge_used` are the API codes
 * of the same name (403, 410, 410); every other code is reported as 422 `login_invalid`.
 */
export type VerifyFailureCode =
  | "bad_tx"
  | "bad_xpub"
  | "bad_domain"
  | "unknown_nonce"
  | "challenge_mismatch"
  | "outpoint_mismatch"
  | "challenge_expired"
  | "challenge_used"
  | "source_missing"
  | "token_source"
  | "source_too_small"
  | "wrong_address"
  | "bad_fee"
  | "bad_signature"
  | "spent";

export type VerifyResult =
  | { ok: true; accountId: string; xpubReceive: string; xpubChange: string }
  | { ok: false; code: VerifyFailureCode; message: string };

const fail = (code: VerifyFailureCode, message: string): VerifyResult => ({ ok: false, code, message });
const HEX = /^(?:[0-9a-f]{2})+$/i;
const TXID = /^[0-9a-f]{64}$/;
const BROWSER_ID = /^[0-9a-f]{64}$/;

export const accountIdFor = (xpubReceive: string): string => binToHex(sha256.hash(utf8ToBin(xpubReceive)));
export const browserIdHashFor = (browserId: string): string => binToHex(sha256.hash(utf8ToBin(browserId)));

/** a mainnet extended public key string */
export const isMainnetXpub = (x: unknown): x is string => {
  if (typeof x !== "string" || x.length > 200) return false;
  const d = decodeHdPublicKey(x);
  return typeof d !== "string" && d.network === "mainnet";
};

/** compressed public key of `xpub`'s child `index` (the xpub is the chain node), or null */
export function pubkeyForXpub(xpub: string, index: number): Uint8Array | null {
  if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) return null;
  const decoded = decodeHdPublicKey(xpub);
  if (typeof decoded === "string") return null;
  const child = deriveHdPublicNodeChild(decoded.node, index, { throwErrors: false });
  return typeof child === "string" ? null : child.publicKey;
}

/** P2PKH locking bytecode of `xpub`'s child `index`. Null if the xpub is invalid. */
export function p2pkhForXpub(xpub: string, index: number): Uint8Array | null {
  const pub = pubkeyForXpub(xpub, index);
  return pub ? encodeLockingBytecodeP2pkh(hash160(pub)) : null;
}

/** exactly `<sig> <pubkey>` as two minimal pushes, or null */
function parseP2pkhUnlocking(unlocking: Uint8Array): { sig: Uint8Array; pubkey: Uint8Array } | null {
  const ins = decodeAuthenticationInstructions(unlocking);
  if (ins.length !== 2) return null;
  const data: Uint8Array[] = [];
  for (const i of ins) {
    if (("malformed" in i && i.malformed) || !("data" in i)) return null;
    data.push(i.data);
  }
  const [sig, pubkey] = data as [Uint8Array, Uint8Array];
  if (!binsAreEqual(flattenBinArray([encodeDataPush(sig), encodeDataPush(pubkey)]), unlocking)) return null;
  return { sig, pubkey };
}

/** Schnorr (64 + 1) or DER ECDSA (DER 8..72 + 1, starts 0x30) signature ending in ALL|FORKID */
function isAllForkIdSignature(sig: Uint8Array): boolean {
  if (sig[sig.length - 1] !== SIGHASH_ALL_FORKID) return false;
  if (sig.length === 65) return true;
  return sig.length >= 9 && sig.length <= 73 && sig[0] === 0x30;
}

const vm = createVirtualMachineBCH();

export async function verifyLogin(req: VerifyInput, deps: VerifyDeps): Promise<VerifyResult> {
  const { signedTxHex, xpubReceive, xpubChange } = (req ?? {}) as Partial<VerifyInput>;
  // 0. keys
  if (!isMainnetXpub(xpubReceive) || !isMainnetXpub(xpubChange)) return fail("bad_xpub", "Invalid or non-mainnet xpub");
  if (xpubReceive === xpubChange) return fail("bad_xpub", "Receive and change xpubs must differ");

  // 1. structure
  if (typeof signedTxHex !== "string" || !HEX.test(signedTxHex)) return fail("bad_tx", "Not a hex transaction");
  const bin = hexToBin(signedTxHex);
  const tx = decodeTransaction(bin);
  if (typeof tx === "string") return fail("bad_tx", "Could not decode transaction");
  if (tx.version !== 2 || tx.locktime !== 0) return fail("bad_tx", "Login tx must be version 2, locktime 0");
  if (tx.inputs.length !== 1 || tx.outputs.length !== 2) return fail("bad_tx", "Login tx must have 1 input and 2 outputs");
  const input = tx.inputs[0]!;
  const [out0, out1] = tx.outputs as [Output, Output];
  if (input.sequenceNumber !== 0xffffffff) return fail("bad_tx", "Input sequence must be final");
  if (out0.token || out1.token) return fail("bad_tx", "Login tx outputs must not carry tokens");
  if (out0.valueSatoshis !== 0n) return fail("bad_tx", "OP_RETURN output must have value 0");
  const op = decodeLoginOpReturn(out0.lockingBytecode);
  if (!op) return fail("bad_tx", "Output 0 is not a login OP_RETURN");

  // 2. challenge binding
  if (op.domain !== deps.domain) return fail("bad_domain", "Signed for a different domain");
  if (op.nonceHex.length !== NONCE_BYTES * 2) return fail("bad_tx", "Bad nonce");
  const ch = await deps.getChallenge(op.nonceHex);
  if (!ch) return fail("unknown_nonce", "Unknown challenge");
  const browserId = deps.browserId;
  if (typeof browserId !== "string" || !BROWSER_ID.test(browserId) || browserIdHashFor(browserId) !== ch.browserIdHash) {
    return fail("challenge_mismatch", "This challenge was issued to a different browser");
  }
  const inputTxid = binToHex(input.outpointTransactionHash);
  if (inputTxid !== ch.outpoint.txid || input.outpointIndex !== ch.outpoint.vout) {
    return fail("outpoint_mismatch", "Input does not spend the challenge outpoint");
  }
  const now = deps.now();
  if (now > ch.expiry || op.expiry !== ch.expiry || op.domain !== ch.domain) {
    return fail("challenge_expired", "Challenge expired or does not match");
  }
  if (ch.usedAt !== null) return fail("challenge_used", "Challenge already used");

  // 3. chain data
  const outpoint = { txid: ch.outpoint.txid, vout: ch.outpoint.vout };
  const source = await deps.getSourceOutput(outpoint);
  if (!source) return fail("source_missing", "Source output not found on chain");
  if (source.token) return fail("token_source", "Sign in with a UTXO that holds no tokens");
  if (source.valueSatoshis < BigInt(MIN_LOGIN_UTXO_SATS)) {
    return fail("source_too_small", `Sign in with a UTXO of at least ${MIN_LOGIN_UTXO_SATS} sats`);
  }

  // 4. address binding (receive xpub only) + fee
  const [pathName, pathIndex] = ch.path;
  const pubkey = pathName === "receive" ? pubkeyForXpub(xpubReceive, pathIndex) : null;
  const expected = pubkey ? encodeLockingBytecodeP2pkh(hash160(pubkey)) : null;
  if (!pubkey || !expected || !binsAreEqual(source.lockingBytecode, expected)) {
    return fail("wrong_address", "Source output is not the wallet's receive address at the stated index");
  }
  if (!binsAreEqual(out1.lockingBytecode, source.lockingBytecode)) {
    return fail("wrong_address", "Output 1 must pay back to the source address");
  }
  const fee = source.valueSatoshis - out1.valueSatoshis;
  if (fee < BigInt(MIN_LOGIN_FEE_SATS) || fee > BigInt(MAX_LOGIN_FEE_SATS)) return fail("bad_fee", `Fee ${fee} out of range`);

  // 5. signature: exactly <sig ALL|FORKID> <derived pubkey>, then full VM evaluation against chain data
  const unlock = parseP2pkhUnlocking(input.unlockingBytecode);
  if (!unlock || !isAllForkIdSignature(unlock.sig) || !binsAreEqual(unlock.pubkey, pubkey)) {
    return fail("bad_signature", "Unlocking bytecode must be <SIGHASH_ALL|FORKID signature> <pubkey>");
  }
  const result = vm.verify({ transaction: tx, sourceOutputs: [{ lockingBytecode: source.lockingBytecode, valueSatoshis: source.valueSatoshis }] });
  if (result !== true) return fail("bad_signature", "Signature did not verify");

  // 6. not double-spent elsewhere
  const txid = hashTransaction(bin);
  if (!TXID.test(txid) || !(await deps.isUnspentOrSpentBy(outpoint, txid))) {
    return fail("spent", "Outpoint was spent by another transaction");
  }

  // 7. single use
  if (!(await deps.markChallengeUsed(ch.nonceHex, now))) return fail("challenge_used", "Challenge already used");

  return { ok: true, accountId: accountIdFor(xpubReceive), xpubReceive, xpubChange };
}
