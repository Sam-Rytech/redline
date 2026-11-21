import { binToHex, sha256, utf8ToBin } from "@bitauth/libauth";

/** Sessions and Telegram link tokens are stored by hash so a leaked DB does not leak live secrets. */
export const tokenHash = (token: string): string => binToHex(sha256.hash(utf8ToBin(token)));
