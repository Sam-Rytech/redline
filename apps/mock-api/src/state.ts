import type { Invoice, MeResponse, Watch } from "@redline/api-types";
import { FREE_WATCH_LIMIT } from "@redline/api-types";

export const SESSION_COOKIE = "rl_session";
export const SESSION_VALUE = "mock-session";

export interface MockState {
  signedIn: boolean;
  proUntil: Date | null;
  telegramLinked: boolean;
  watches: Watch[];
  invoices: Map<string, Invoice>;
  nextId: number;
}

export function newState(): MockState {
  return { signedIn: false, proUntil: null, telegramLinked: false, watches: [], invoices: new Map(), nextId: 1 };
}

export function me(s: MockState): MeResponse {
  const pro = s.proUntil !== null && s.proUntil.getTime() > Date.now();
  return {
    accountId: "5e1f".padEnd(64, "0"),
    pro,
    proUntil: s.proUntil?.toISOString() ?? null,
    telegramLinked: s.telegramLinked,
    watchLimit: pro ? null : FREE_WATCH_LIMIT,
  };
}
