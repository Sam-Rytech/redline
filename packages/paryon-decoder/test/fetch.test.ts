import { describe, expect, it } from "vitest";
import {
  connectFirst,
  createHostRotation,
  createSnapshotFetcher,
  DEFAULT_ELECTRUM_HOSTS,
  electrumHosts,
  fetchSnapshot,
  MAINNET_V1,
  PARYON_ADDRESSES,
  type SnapshotProvider,
} from "../src/index.js";

const hex = (n: number, bytes: number) => {
  let s = "";
  for (let i = 0; i < bytes; i++) s += (Math.floor(n / 2 ** (8 * i)) % 256).toString(16).padStart(2, "0");
  return s;
};
const PRICE_UTXO = {
  txid: "p1",
  vout: 0,
  satoshis: 1000n,
  token: { category: MAINNET_V1.paryonTokenId, amount: 0n, nft: { capability: "mutable" as const, commitment: "00" + hex(1, 4) + hex(20000, 4) } },
};

function fakeHosts(behaviour: Record<string, "refuse" | "hang" | "ok" | "fail-request">) {
  const log: string[] = [];
  const make = (host: string): SnapshotProvider => ({
    async connect() {
      log.push(`connect ${host}`);
      const b = behaviour[host] ?? "refuse";
      if (b === "refuse") throw new Error(`ECONNREFUSED ${host}`);
      if (b === "hang") await new Promise(() => {});
    },
    async disconnect() {
      log.push(`disconnect ${host}`);
      return true;
    },
    async getUtxos(address) {
      if (behaviour[host] === "fail-request") throw new Error("request failed");
      return address === PARYON_ADDRESSES.price ? [PRICE_UTXO] : [];
    },
    async getBlockHeight() {
      return 950_000;
    },
  });
  return { make, log };
}

describe("electrumHosts", () => {
  it("default list, env host first and not duplicated", () => {
    expect(DEFAULT_ELECTRUM_HOSTS).toEqual([
      "bch.imaginary.cash",
      "electrum.imaginary.cash",
      "bch.loping.net",
      "fulcrum.greyh.at",
      "electroncash.dk",
    ]);
    expect(electrumHosts()).toEqual(DEFAULT_ELECTRUM_HOSTS);
    expect(electrumHosts("my.host")).toEqual(["my.host", ...DEFAULT_ELECTRUM_HOSTS]);
    expect(electrumHosts("bch.loping.net")[0]).toBe("bch.loping.net");
    expect(electrumHosts("bch.loping.net")).toHaveLength(5);
  });
});

describe("connectFirst", () => {
  it("returns the first host that connects, disconnecting the failed ones", async () => {
    const { make, log } = fakeHosts({ b: "ok", c: "ok" });
    const got = await connectFirst(["a", "b", "c"], make);
    expect(got.host).toBe("b");
    expect(log).toEqual(["connect a", "disconnect a", "connect b"]);
  });

  it("times out a hanging connect and moves on", async () => {
    const { make } = fakeHosts({ a: "hang", b: "ok" });
    const got = await connectFirst(["a", "b"], make, { connectTimeoutMs: 20 });
    expect(got.host).toBe("b");
  });

  it("throws listing every host when all fail", async () => {
    const { make } = fakeHosts({});
    await expect(connectFirst(["a", "b"], make)).rejects.toThrow(/a: ECONNREFUSED a.*b: ECONNREFUSED b/);
  });

  it("rejects an empty host list", async () => {
    await expect(connectFirst([], fakeHosts({}).make)).rejects.toThrow(/no Electrum hosts/);
  });
});

describe("fetchSnapshot host fallback", () => {
  it("uses the next host when the first refuses", async () => {
    const { make, log } = fakeHosts({ second: "ok" });
    const snap = await fetchSnapshot({ hostnames: ["first", "second"], provider: make });
    expect(snap.priceUsd).toBe(200);
    expect(snap.blockHeight).toBe(950_000);
    expect(log).toEqual(["connect first", "disconnect first", "connect second", "disconnect second"]);
  });

  it("a request failure after connecting is not retried on another host", async () => {
    const { make, log } = fakeHosts({ first: "fail-request", second: "ok" });
    await expect(fetchSnapshot({ hostnames: ["first", "second"], provider: make })).rejects.toThrow("request failed");
    expect(log).toEqual(["connect first", "disconnect first"]);
  });

  it("legacy single hostname still works", async () => {
    const { make, log } = fakeHosts({ only: "ok" });
    await fetchSnapshot({ hostname: "only", provider: make });
    expect(log[0]).toBe("connect only");
  });
});

describe("createHostRotation", () => {
  it("starts at the last host that succeeded; a failure moves to the next one", () => {
    const r = createHostRotation(["a", "b", "c"]);
    expect(r.ordered()).toEqual(["a", "b", "c"]);
    r.succeeded("c");
    expect(r.ordered()).toEqual(["c", "a", "b"]);
    r.failed("c");
    expect(r.ordered()).toEqual(["a", "b", "c"]);
    r.failed(undefined); // no host connected: just advance
    expect(r.ordered()).toEqual(["b", "c", "a"]);
  });
});

describe("createSnapshotFetcher", () => {
  /** hosts: "ok" answers, "stall" connects then never answers until released, "fail" connects then errors */
  function hosts(behaviour: Record<string, "ok" | "stall" | "fail">) {
    const connects: string[] = [];
    const release: Array<() => void> = [];
    const make = (host: string): SnapshotProvider => ({
      async connect() {
        connects.push(host);
      },
      async disconnect() {
        return true;
      },
      async getUtxos(address) {
        if (behaviour[host] === "stall") await new Promise<void>((res) => release.push(res));
        if (behaviour[host] === "fail") throw new Error("request failed");
        return address === PARYON_ADDRESSES.price ? [PRICE_UTXO] : [];
      },
      async getBlockHeight() {
        return 950_000;
      },
    });
    return { make, connects, release };
  }

  it("a host that connects but stalls is skipped on the next refresh; the good host is kept", async () => {
    const h = hosts({ a: "stall", b: "ok", c: "ok" });
    const fetch = createSnapshotFetcher({ hostnames: ["a", "b", "c"], provider: h.make });
    void fetch().catch(() => {}); // stalls on a (the reader would time it out)
    await new Promise((r) => setTimeout(r, 0));
    expect((await fetch()).blockHeight).toBe(950_000);
    expect(h.connects).toEqual(["a", "b"]);
    await fetch();
    expect(h.connects).toEqual(["a", "b", "b"]); // starts at the last good host
    // the stalled fetch finishing late does not move the start back to a
    for (const r of h.release) r();
    await new Promise((r) => setTimeout(r, 0));
    await fetch();
    expect(h.connects.at(-1)).toBe("b");
  });

  it("a failed refresh rotates to the next host", async () => {
    const h = hosts({ a: "fail", b: "ok" });
    const fetch = createSnapshotFetcher({ hostnames: ["a", "b"], provider: h.make });
    await expect(fetch()).rejects.toThrow("request failed");
    await fetch();
    expect(h.connects).toEqual(["a", "b"]);
  });
});
