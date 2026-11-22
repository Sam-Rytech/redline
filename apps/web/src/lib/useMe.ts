import type { MeResponse } from "@redline/api-types";
import { ApiFailure } from "./api";
import { useApi } from "./useApi";

/** Signed-in account, or null when the server says 401. */
export function useMe() {
  const r = useApi<MeResponse>("/me");
  const signedOut = r.error instanceof ApiFailure && r.error.status === 401;
  return { ...r, me: r.data, signedOut };
}
