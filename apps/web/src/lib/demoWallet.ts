import type { ChallengeResponse, MeResponse } from "@redline/api-types";
import { api } from "./api";

/** Development only: signs in against the mock API with a placeholder wallet. */
export const demoWalletEnabled = import.meta.env.DEV;

export async function demoSignIn(): Promise<MeResponse> {
  await api<ChallengeResponse>("/auth/challenge", {
    method: "POST",
    json: { xpubReceive: "xpub-demo-r", xpubChange: "xpub-demo-c", outpoint: { txid: "11".repeat(32), vout: 0 }, path: ["receive", 0] },
  });
  return api<MeResponse>("/auth/verify", { method: "POST", json: { signedTxHex: "00" } });
}
