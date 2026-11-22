// connectWallet() wiring, with the relay (network) faked out.
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const relay = vi.hoisted(() => ({
  statusCallback: null as null | ((p: { client: unknown; status: { status: string } }) => void),
  cleanup: 0,
  options: undefined as unknown,
}));

vi.mock("@wizardconnect/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@wizardconnect/core")>();
  return {
    ...real,
    initiateDappRelay: (cb: NonNullable<typeof relay.statusCallback>, options?: unknown) => {
      relay.statusCallback = cb;
      relay.options = options;
      return {
        client: new EventEmitter(),
        uri: "wiz://pair?x=1",
        qrUri: "wiz://pair?x=1&qr",
        credentials: { privateKey: "00".repeat(32), secret: "s" },
        events: new EventEmitter(),
        cleanup: () => {
          relay.cleanup++;
        },
      };
    },
  };
});

const { connectWallet, PATHS_WAIT_MS } = await import("../src/client/connect.js");

const PATHS = [{ name: "receive", xpub: "x" }, { name: "change", xpub: "y" }];
const withPaths = (m: { getSessionPaths: () => unknown }) => {
  m.getSessionPaths = () => PATHS;
};

beforeEach(() => {
  relay.statusCallback = null;
  relay.cleanup = 0;
});

describe("connectWallet", () => {
  it("exposes the pairing URI and resolves ready on walletready", async () => {
    const c = connectWallet();
    expect(c.qrUri).toBe("wiz://pair?x=1&qr");
    expect(relay.statusCallback).toBeTypeOf("function");
    expect(c.walletName()).toBeNull();
    c.manager.walletName = "Paytaca";
    withPaths(c.manager as never);
    c.manager.emit("walletready", {} as never);
    await expect(c.ready).resolves.toBeUndefined();
    expect(c.walletName()).toBe("Paytaca");
    await c.close();
    expect(relay.cleanup).toBe(1);
    await c.close(); // idempotent
    expect(relay.cleanup).toBe(1);
  });

  it("waits for the paths when the first walletready has none (Selene)", async () => {
    const c = connectWallet();
    let done = false;
    void c.ready.then(() => (done = true));
    c.manager.emit("walletready", {} as never); // no paths yet
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    withPaths(c.manager as never);
    c.manager.emit("walletready", {} as never);
    await expect(c.ready).resolves.toBeUndefined();
    await c.close();
  });

  it("picks up paths that arrive without another walletready", async () => {
    vi.useFakeTimers();
    try {
      const c = connectWallet();
      c.manager.emit("walletready", {} as never);
      withPaths(c.manager as never);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(c.ready).resolves.toBeUndefined();
      await c.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting for paths after PATHS_WAIT_MS, so the caller gets a clear no_paths error", async () => {
    vi.useFakeTimers();
    try {
      const c = connectWallet();
      let done = false;
      void c.ready.then(() => (done = true));
      c.manager.emit("walletready", {} as never);
      await vi.advanceTimersByTimeAsync(PATHS_WAIT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(done).toBe(true);
      await c.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects ready when the wallet disconnects before it is ready", async () => {
    const c = connectWallet({ dappName: "Test" });
    c.manager.emit("disconnect", "user_disconnect" as never, "bye");
    await expect(c.ready).rejects.toThrow(/disconnected.*bye/i);
    await c.close();
  });

  it("rejects ready when closed before the wallet is ready", async () => {
    const c = connectWallet();
    await c.close();
    await expect(c.ready).rejects.toThrow(/closed/i);
  });

  it("reports relay status through onRelayStatus", async () => {
    const seen: string[] = [];
    const c = connectWallet({ onRelayStatus: (s, err) => seen.push(`${s}:${err ?? ""}`) });
    relay.statusCallback!({ client: null, status: { status: "reconnecting", error: "socket closed" } as never });
    relay.statusCallback!({ client: null, status: { status: "connected", error: null } as never });
    expect(seen).toEqual(["reconnecting:socket closed", "connected:"]);
    await c.close();
  });

  it("uses no session persistence: nothing is read or written to localStorage, even after walletready", async () => {
    const calls: string[] = [];
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (calls.push(`get:${k}`), store.get(k) ?? null),
      setItem: (k: string, v: string) => (calls.push(`set:${k}`), void store.set(k, v)),
      removeItem: (k: string) => (calls.push(`remove:${k}`), void store.delete(k)),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    });
    try {
      const c = connectWallet();
      c.manager.walletName = "Paytaca";
      withPaths(c.manager as never);
    c.manager.emit("walletready", {} as never);
      await c.ready;
      expect(c.manager.loadStoredSession()).toBeNull();
      await c.close();
      expect(store.size).toBe(0);
      expect(calls.filter((x) => !x.startsWith("get:"))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("forwards the relay (client, status) to manager.updateConnection", async () => {
    const c = connectWallet();
    const spy = vi.spyOn(c.manager, "updateConnection").mockImplementation(() => {});
    const client = { id: "client" };
    const status = { status: "connected", error: null };
    relay.statusCallback!({ client, status } as never);
    expect(spy).toHaveBeenCalledExactlyOnceWith(client, status);
    await c.close();
  });
});
