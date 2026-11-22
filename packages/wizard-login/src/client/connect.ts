// Pair with a WizardConnect wallet (Paytaca, Selene, …) over the Nostr relay.
import { initiateDappRelay, type DappRelayOptions } from "@wizardconnect/core";
import { DappConnectionManager } from "@wizardconnect/dapp";

export interface WalletConnection {
  /** render as a QR code, or as a link for same-device wallets */
  qrUri: string;
  /**
   * resolves once the wallet is ready and has shared its receive and change paths (or
   * PATHS_WAIT_MS after a wallet_ready without them); rejects if the wallet disconnects (or close()
   * is called) before that
   */
  ready: Promise<void>;
  manager: DappConnectionManager;
  walletName(): string | null;
  /** sendDisconnect (best effort), destroy the manager, close the relay. Idempotent. */
  close(): Promise<void>;
}

export interface ConnectWalletOptions {
  /** default "Redline" */
  dappName?: string;
  dappIcon?: string;
  relay?: DappRelayOptions;
  /** relay (Nostr transport) status changes, e.g. to show "reconnecting…" and back */
  onRelayStatus?: (status: "connected" | "reconnecting" | "disconnected" | "session_deleted", error: string | null) => void;
}

/** how often to look for the paths after a wallet_ready without them */
export const PATHS_POLL_MS = 250;
/** how long to wait for the paths after the first wallet_ready */
export const PATHS_WAIT_MS = 15_000;

export function connectWallet(opts: ConnectWalletOptions = {}): WalletConnection {
  // v1: no session persistence → no reconnect after a page reload
  const manager = new DappConnectionManager(opts.dappName ?? "Redline", opts.dappIcon, { session: false });
  const relay = initiateDappRelay(({ client, status }) => {
    manager.updateConnection(client, status);
    opts.onRelayStatus?.(status.status, status.error);
  }, opts.relay);
  manager.attachRelay(relay);

  // Some wallets (Selene) send a first wallet_ready with no paths and the xpubs in a later one, so
  // `ready` waits until the receive and change paths are there. If they never come, it resolves
  // PATHS_WAIT_MS after the first wallet_ready and the caller gets a clear "no paths" error.
  const hasPaths = () => {
    const names = new Set(manager.getSessionPaths().map((p) => p.name));
    return names.has("receive") && names.has("change");
  };
  let settled = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  let rejectReady: (e: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      settled = true;
      clearInterval(poll);
      clearTimeout(giveUp);
      manager.off("walletready", onReady);
      manager.off("disconnect", onDisconnect);
    };
    rejectReady = (e) => {
      if (settled) return;
      cleanup();
      reject(e);
    };
    const finish = () => {
      if (settled) return;
      cleanup();
      resolve();
    };
    const onReady = () => {
      if (settled) return;
      if (hasPaths()) return finish();
      poll ??= setInterval(() => {
        if (hasPaths()) finish();
      }, PATHS_POLL_MS);
      giveUp ??= setTimeout(finish, PATHS_WAIT_MS);
    };
    const onDisconnect = (reason: string, message: string | undefined) =>
      rejectReady(new Error(`Wallet disconnected before it was ready (${reason}${message ? `: ${message}` : ""})`));
    manager.on("walletready", onReady);
    manager.once("disconnect", onDisconnect);
  });
  // callers that never await `ready` must not get an unhandled rejection
  ready.catch(() => {});

  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= (async () => {
      rejectReady(new Error("Wallet connection closed"));
      try {
        await manager.sendDisconnect("Dapp closed the connection");
      } catch {
        // best effort: the relay may already be down
      }
      try {
        // rejects any pending sign request; its outcome is unknown — never retry it with another wallet
        await manager.destroy();
      } finally {
        relay.cleanup();
      }
    })();
    return closing;
  };

  return { qrUri: relay.qrUri, ready, manager, walletName: () => manager.walletName, close };
}
