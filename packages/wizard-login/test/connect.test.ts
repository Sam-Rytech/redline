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

const { connectWallet } = await import("../src/client/connect.js");

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
    c.manager.emit("walletready", {} as never);
    await expect(c.ready).resolves.toBeUndefined();
    expect(c.walletName()).toBe("Paytaca");
    await c.close();
    expect(relay.cleanup).toBe(1);
    await c.close(); // idempotent
    expect(relay.cleanup).toBe(1);
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

  it("uses no session persistence (no localStorage reconnect in v1)", () => {
    const c = connectWallet();
    expect(c.manager.loadStoredSession()).toBeNull();
    void c.close();
  });
});
