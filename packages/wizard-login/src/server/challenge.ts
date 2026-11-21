import { binToHex } from "@bitauth/libauth";
import { NONCE_BYTES } from "../protocol.js";
import {
  BROWSER_ID_BYTES,
  CHALLENGE_TTL_SECONDS,
  MAX_PATH_INDEX,
  browserIdHashFor,
  type LoginOutpoint,
  type StoredChallenge,
} from "./verify.js";

export class ChallengeError extends Error {
  constructor(
    readonly code: "bad_path" | "bad_request",
    message: string,
  ) {
    super(message);
    this.name = "ChallengeError";
  }
}

export interface ChallengeInput {
  outpoint: LoginOutpoint;
  /** Only the receive path can sign in: the login must prove the xpub the account id is derived from. */
  path: ["receive", number];
}

const TXID = /^[0-9a-f]{64}$/;

/**
 * Validates the request and returns a fresh challenge (not yet stored) plus the browser id.
 * Store `challenge` (it holds only the browser id's hash); give `browserId` to the requesting
 * browser only, in the HttpOnly rl_ch cookie. Throws ChallengeError.
 */
export function createChallenge(
  input: ChallengeInput,
  ctx: { domain: string; now: number; randomBytes(n: number): Uint8Array },
): { challenge: StoredChallenge; browserId: string } {
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

  const nonce = ctx.randomBytes(NONCE_BYTES);
  const id = ctx.randomBytes(BROWSER_ID_BYTES);
  if (nonce.length !== NONCE_BYTES || id.length !== BROWSER_ID_BYTES) throw new Error("randomBytes returned the wrong length");
  const browserId = binToHex(id);
  return {
    browserId,
    challenge: {
      nonceHex: binToHex(nonce),
      browserIdHash: browserIdHashFor(browserId),
      outpoint: { txid: outpoint.txid, vout: outpoint.vout },
      path: ["receive", path[1]],
      domain: ctx.domain,
      expiry: ctx.now + CHALLENGE_TTL_SECONDS,
      usedAt: null,
    },
  };
}
