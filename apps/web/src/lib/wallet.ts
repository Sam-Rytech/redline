import { connectWallet, type WalletConnection } from "@redline/wizard-login/client";
import { useSyncExternalStore } from "react";

export type WalletState =
  | { status: "idle" }
  | { status: "pairing"; qrUri: string }
  | { status: "ready"; name: string | null }
  | { status: "failed"; message: string };

let conn: WalletConnection | null = null;
let state: WalletState = { status: "idle" };
const listeners = new Set<() => void>();

function set(next: WalletState) {
  state = next;
  listeners.forEach((l) => l());
}

/** Starts a WizardConnect pairing, or returns the live one. Resolves once the wallet has shared its keys. */
export async function pairWallet(): Promise<WalletConnection> {
  if (conn && state.status === "ready") return conn;
  if (!conn) {
    conn = connectWallet({ dappName: "Redline" });
    const mine = conn;
    mine.manager.on("disconnect", () => {
      if (conn === mine) {
        conn = null;
        set({ status: "idle" });
      }
    });
    set({ status: "pairing", qrUri: mine.qrUri });
  }
  const current = conn;
  try {
    await current.ready;
    set({ status: "ready", name: current.walletName() ?? null });
    return current;
  } catch (e) {
    if (conn === current) conn = null;
    set({ status: "failed", message: (e as Error).message || "The wallet disconnected." });
    throw e;
  }
}

export function walletManager() {
  return state.status === "ready" ? conn?.manager ?? null : null;
}

export async function disconnectWallet() {
  const c = conn;
  conn = null;
  set({ status: "idle" });
  await c?.close();
}

export function useWallet(): WalletState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
