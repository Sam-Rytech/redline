// Pair with a WizardConnect wallet (Paytaca, Selene, …) over the Nostr relay.
import { initiateDappRelay, type DappRelayOptions } from "@wizardconnect/core";
import { DappConnectionManager } from "@wizardconnect/dapp";

export interface WalletConnection {
  /** render as a QR code, or as a link for same-device wallets */
  qrUri: string;
  /** resolves on walletready; rejects if the wallet disconnects (or close() is called) before that */
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
}

export function connectWallet(opts: ConnectWalletOptions = {}): WalletConnection {
  // v1: no session persistence → no reconnect after a page reload
  const manager = new DappConnectionManager(opts.dappName ?? "Redline", opts.dappIcon, { session: false });
  const relay = initiateDappRelay(({ client, status }) => manager.updateConnection(client, status), opts.relay);
  manager.attachRelay(relay);

  let settled = false;
  let rejectReady: (e: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = (e) => {
      if (settled) return;
      settled = true;
      manager.off("walletready", onReady);
      manager.off("disconnect", onDisconnect);
      reject(e);
    };
    const onReady = () => {
      if (settled) return;
      settled = true;
      manager.off("disconnect", onDisconnect);
      resolve();
    };
    const onDisconnect = (reason: string, message: string | undefined) =>
      rejectReady(new Error(`Wallet disconnected before it was ready (${reason}${message ? `: ${message}` : ""})`));
    manager.once("walletready", onReady);
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
