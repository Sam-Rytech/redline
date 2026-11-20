// Server half of WizardConnect sign-in. Framework-agnostic: all I/O is injected.
// Every chain fact (source output script + value, spent state) comes from `deps`, never the client.
import {
  binToHex,
  binsAreEqual,
  createVirtualMachineBCH,
  decodeHdPublicKey,
  decodeTransaction,
  deriveHdPublicNodeChild,
  encodeLockingBytecodeP2pkh,
  hash160,
  hashTransaction,
  hexToBin,
  sha256,
  utf8ToBin,
  type Output,
} from "@bitauth/libauth";
import { MAX_LOGIN_FEE_SATS, MIN_LOGIN_FEE_SATS, NONCE_BYTES, decodeLoginOpReturn } from "../protocol.js";

export const CHALLENGE_TTL_SECONDS = 300;
export const MAX_PATH_INDEX = 999;

export type LoginPathName = "receive" | "change";
export interface LoginOutpoint {
  txid: string;
  vout: number;
}

export interface StoredChallenge {
  nonceHex: string;
  expiry: number;
  domain: string;
  outpoint: LoginOutpoint;
  path: [LoginPathName, number];
  xpubReceive: string;
  xpubChange: string;
  usedAt: number | null;
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
}

export type VerifyFailureCode =
  | "bad_tx"
  | "bad_domain"
  | "unknown_nonce"
  | "outpoint_mismatch"
  | "expired"
  | "nonce_used"
  | "source_missing"
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

export const accountIdFor = (xpubReceive: string): string => binToHex(sha256.hash(utf8ToBin(xpubReceive)));

/** P2PKH locking bytecode of `xpub`'s child `index` (the xpub is the chain node). Null if the xpub is invalid. */
export function p2pkhForXpub(xpub: string, index: number): Uint8Array | null {
  const decoded = decodeHdPublicKey(xpub);
  if (typeof decoded === "string") return null;
  const child = deriveHdPublicNodeChild(decoded.node, index, { throwErrors: false });
  if (typeof child === "string") return null;
  return encodeLockingBytecodeP2pkh(hash160(child.publicKey));
}

const vm = createVirtualMachineBCH();

export async function verifyLogin(signedTxHex: string, deps: VerifyDeps): Promise<VerifyResult> {
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
  const inputTxid = binToHex(input.outpointTransactionHash);
  if (inputTxid !== ch.outpoint.txid || input.outpointIndex !== ch.outpoint.vout) {
    return fail("outpoint_mismatch", "Input does not spend the challenge outpoint");
  }
  const now = deps.now();
  if (now > ch.expiry || op.expiry !== ch.expiry || op.domain !== ch.domain) {
    return fail("expired", "Challenge expired or does not match");
  }
  if (ch.usedAt !== null) return fail("nonce_used", "Challenge already used");

  // 3. chain data
  const outpoint = { txid: ch.outpoint.txid, vout: ch.outpoint.vout };
  const source = await deps.getSourceOutput(outpoint);
  if (!source) return fail("source_missing", "Source output not found on chain");

  // 4. address binding + fee
  const [pathName, pathIndex] = ch.path;
  const xpub = pathName === "receive" ? ch.xpubReceive : pathName === "change" ? ch.xpubChange : null;
  const expected = xpub !== null && Number.isInteger(pathIndex) && pathIndex >= 0 ? p2pkhForXpub(xpub, pathIndex) : null;
  if (!expected || !binsAreEqual(source.lockingBytecode, expected)) {
    return fail("wrong_address", "Source output is not the wallet address at the stated path");
  }
  if (!binsAreEqual(out1.lockingBytecode, source.lockingBytecode)) {
    return fail("wrong_address", "Output 1 must pay back to the source address");
  }
  const fee = source.valueSatoshis - out1.valueSatoshis;
  if (fee < BigInt(MIN_LOGIN_FEE_SATS) || fee > BigInt(MAX_LOGIN_FEE_SATS)) return fail("bad_fee", `Fee ${fee} out of range`);

  // 5. signature: full VM evaluation against the chain's source output
  const sourceOutput: Output = {
    lockingBytecode: source.lockingBytecode,
    valueSatoshis: source.valueSatoshis,
    ...(source.token && { token: source.token }),
  };
  const result = vm.verify({ transaction: tx, sourceOutputs: [sourceOutput] });
  if (result !== true) return fail("bad_signature", "Signature did not verify");

  // 6. not double-spent elsewhere
  const txid = hashTransaction(bin);
  if (!TXID.test(txid) || !(await deps.isUnspentOrSpentBy(outpoint, txid))) {
    return fail("spent", "Outpoint was spent by another transaction");
  }

  // 7. single use
  if (!(await deps.markChallengeUsed(ch.nonceHex, now))) return fail("nonce_used", "Challenge already used");

  return { ok: true, accountId: accountIdFor(ch.xpubReceive), xpubReceive: ch.xpubReceive, xpubChange: ch.xpubChange };
}
