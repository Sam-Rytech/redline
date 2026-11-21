import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
export const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

const IV_BYTES = 12;
const TAG_BYTES = 16;

export type AgeResult = "ok" | "blocked";

export interface Secrets {
  /** AES-256-GCM encrypt `plain`, bound to `aad` (the session id) so a row cannot be moved to another session. */
  seal(plain: string, aad: string): Uint8Array;
  /** null if the data was altered, belongs to another session, or was sealed with another secret */
  open(sealed: Uint8Array, aad: string): string | null;
  /** value for the rl_age cookie: "<result>.<signature>" */
  signAge(result: AgeResult): string;
  /** the result carried by a valid rl_age cookie, or null */
  readAge(cookie: string | undefined): AgeResult | null;
}

/** Derives separate keys for session encryption and the age cookie from SESSION_SECRET. */
export function createSecrets(sessionSecret: string): Secrets {
  const key = (info: string) => Buffer.from(hkdfSync("sha256", sessionSecret, "redline", info, 32));
  const sessionKey = key("session-keys");
  const ageKey = key("age-cookie");
  const ageSig = (result: string) => createHmac("sha256", ageKey).update(`age:${result}`).digest("hex");

  return {
    seal(plain, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", sessionKey, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body]));
    },
    open(sealed, aad) {
      try {
        const buf = Buffer.from(sealed);
        if (buf.length < IV_BYTES + TAG_BYTES) return null;
        const decipher = createDecipheriv("aes-256-gcm", sessionKey, buf.subarray(0, IV_BYTES));
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
      } catch {
        return null;
      }
    },
    signAge(result) {
      return `${result}.${ageSig(result)}`;
    },
    readAge(cookie) {
      if (!cookie) return null;
      const [result, sig] = cookie.split(".");
      if ((result !== "ok" && result !== "blocked") || !sig || !/^[0-9a-f]{64}$/.test(sig)) return null;
      const want = Buffer.from(ageSig(result), "hex");
      return timingSafeEqual(want, Buffer.from(sig, "hex")) ? result : null;
    },
  };
}
