import { binToHex, decodeHdPublicKey } from "@bitauth/libauth";
import { NONCE_BYTES } from "../protocol.js";
import {
  BINDING_BYTES,
  CHALLENGE_TTL_SECONDS,
  MAX_PATH_INDEX,
  bindingHashFor,
  type LoginOutpoint,
  type StoredChallenge,
} from "./verify.js";

export class ChallengeError extends Error {
  constructor(
    readonly code: "bad_xpub" | "bad_path" | "bad_request",
    message: string,
  ) {
    super(message);
    this.name = "ChallengeError";
  }
}

export interface ChallengeInput {
  xpubReceive: string;
  xpubChange: string;
  outpoint: LoginOutpoint;
  /** Only the receive path can sign in: the login must prove the xpub the account id is derived from. */
  path: ["receive", number];
}

const TXID = /^[0-9a-f]{64}$/;
const isMainnetXpub = (x: unknown): x is string => {
  if (typeof x !== "string" || x.length > 200) return false;
  const d = decodeHdPublicKey(x);
  return typeof d !== "string" && d.network === "mainnet";
};

/**
 * Validates the request and returns a fresh challenge (not yet stored) plus the browser binding
 * token. Store `challenge` (it holds only the token's hash); hand `bindingToken` to the requesting
 * browser only (HttpOnly cookie). Throws ChallengeError.
 */
export function createChallenge(
  input: ChallengeInput,
  ctx: { domain: string; now: number; randomBytes(n: number): Uint8Array },
): { challenge: StoredChallenge; bindingToken: string } {
  const { outpoint, path } = (input ?? {}) as Partial<ChallengeInput>;
  if (!outpoint || typeof outpoint.txid !== "string" || !TXID.test(outpoint.txid)) {
    throw new ChallengeError("bad_request", "outpoint.txid must be 64 lowercase hex chars");
  }
  if (!Number.isInteger(outpoint.vout) || outpoint.vout < 0 || outpoint.vout > 0xffffffff) {
    throw new ChallengeError("bad_request", "outpoint.vout must be a uint32");
  }
  if (!Array.isArray(path) || path.length !== 2) throw new ChallengeError("bad_request", 'path must be ["receive", index]');
  if (path[0] !== "receive") throw new ChallengeError("bad_path", "Sign in with a receive-path UTXO");
  if (!Number.isInteger(path[1]) || path[1] < 0 || path[1] > MAX_PATH_INDEX) {
    throw new ChallengeError("bad_request", `path index must be 0..${MAX_PATH_INDEX}`);
  }
  if (!isMainnetXpub(input.xpubReceive) || !isMainnetXpub(input.xpubChange)) {
    throw new ChallengeError("bad_xpub", "Invalid or non-mainnet xpub");
  }
  if (input.xpubReceive === input.xpubChange) throw new ChallengeError("bad_xpub", "Receive and change xpubs must differ");

  const nonce = ctx.randomBytes(NONCE_BYTES);
  const binding = ctx.randomBytes(BINDING_BYTES);
  if (nonce.length !== NONCE_BYTES || binding.length !== BINDING_BYTES) throw new Error("randomBytes returned the wrong length");
  const bindingToken = binToHex(binding);
  return {
    bindingToken,
    challenge: {
      nonceHex: binToHex(nonce),
      expiry: ctx.now + CHALLENGE_TTL_SECONDS,
      domain: ctx.domain,
      outpoint: { txid: outpoint.txid, vout: outpoint.vout },
      path: ["receive", path[1]],
      xpubReceive: input.xpubReceive,
      xpubChange: input.xpubChange,
      bindingHash: bindingHashFor(bindingToken),
      usedAt: null,
    },
  };
}
