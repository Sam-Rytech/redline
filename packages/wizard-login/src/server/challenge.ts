import { binToHex, decodeHdPublicKey } from "@bitauth/libauth";
import { NONCE_BYTES } from "../protocol.js";
import { CHALLENGE_TTL_SECONDS, MAX_PATH_INDEX, type LoginOutpoint, type LoginPathName, type StoredChallenge } from "./verify.js";

export class ChallengeError extends Error {
  constructor(
    readonly code: "bad_xpub" | "bad_request",
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
  path: [LoginPathName, number];
}

const TXID = /^[0-9a-f]{64}$/;
const isXpub = (x: unknown): x is string => typeof x === "string" && x.length < 200 && typeof decodeHdPublicKey(x) !== "string";

/** Validates the request and returns a fresh challenge (not yet stored). Throws ChallengeError. */
export function createChallenge(
  input: ChallengeInput,
  ctx: { domain: string; now: number; randomBytes(n: number): Uint8Array },
): StoredChallenge {
  const { outpoint, path } = (input ?? {}) as Partial<ChallengeInput>;
  if (!outpoint || typeof outpoint.txid !== "string" || !TXID.test(outpoint.txid)) {
    throw new ChallengeError("bad_request", "outpoint.txid must be 64 lowercase hex chars");
  }
  if (!Number.isInteger(outpoint.vout) || outpoint.vout < 0 || outpoint.vout > 0xffffffff) {
    throw new ChallengeError("bad_request", "outpoint.vout must be a uint32");
  }
  if (!Array.isArray(path) || path.length !== 2 || (path[0] !== "receive" && path[0] !== "change")) {
    throw new ChallengeError("bad_request", 'path must be ["receive" | "change", index]');
  }
  if (!Number.isInteger(path[1]) || path[1] < 0 || path[1] > MAX_PATH_INDEX) {
    throw new ChallengeError("bad_request", `path index must be 0..${MAX_PATH_INDEX}`);
  }
  if (!isXpub(input.xpubReceive) || !isXpub(input.xpubChange)) throw new ChallengeError("bad_xpub", "Invalid xpub");
  const nonce = ctx.randomBytes(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new Error("randomBytes returned the wrong length");
  return {
    nonceHex: binToHex(nonce),
    expiry: ctx.now + CHALLENGE_TTL_SECONDS,
    domain: ctx.domain,
    outpoint: { txid: outpoint.txid, vout: outpoint.vout },
    path: [path[0], path[1]],
    xpubReceive: input.xpubReceive,
    xpubChange: input.xpubChange,
    usedAt: null,
  };
}
