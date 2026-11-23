// Client ↔ server compatibility: wizardLogin() against the real Redline app (createApp) with an
// in-memory DB and a fake chain, through a fake fetch that keeps cookies like a browser would.
import { decodeRelayRequest, viaRelay } from "./relay-fake.js";
import { binToHex, encodeTransaction, hexToBin, lockingBytecodeToCashAddress, sha256, utf8ToBin, type TransactionCommon } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import type { MeResponse, Utxo } from "@redline/api-types";
import { createApp } from "../../../apps/server/src/app.js";
import { createSecrets } from "../../../apps/server/src/crypto.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import type { Chain } from "../../../apps/server/src/electrum.js";
import type { ChainReader } from "../../../apps/server/src/reader.js";
import { LoginError, wizardLogin, type LoginStep, type LoginWallet } from "../src/client/login.js";
import { LOGIN_FEE_SATS } from "../src/protocol.js";
import { makeWallet, signP2pkhInput0, type TestWallet } from "./helpers.js";

const DOMAIN = "redline.test";
const ORIGIN = "http://localhost:5174";
const NOW = new Date("2026-11-21T12:00:00.000Z");
const wallet = makeWallet(7);
const other = makeWallet(8);
const addr = (b: Uint8Array) => {
  const r = lockingBytecodeToCashAddress({ bytecode: b, prefix: "bitcoincash" });
  if (typeof r === "string") throw new Error(r);
  return r.address;
};
const RECEIVE = (i: number) => addr(wallet.lockingBytecode("receive", i));
const tokenOf = (category: string): Utxo["token"] => ({ category, amount: "5", nft: null });

const TX_A = "a1".repeat(32);
const TX_B = "b2".repeat(32);
/** The wallet's coins: the login must pick receive/3 vout 1 (smallest plain coin ≥ 2000). */
const DEFAULT_UTXOS: Utxo[] = [
  { txid: TX_A, vout: 0, address: RECEIVE(0), satoshis: 1_000, height: 10, token: null }, // too small
  { txid: TX_A, vout: 1, address: RECEIVE(3), satoshis: 4_000, height: 10, token: null }, // ← pick
  { txid: TX_A, vout: 2, address: RECEIVE(5), satoshis: 2_500, height: 10, token: tokenOf("cc".repeat(32)) }, // tokens
  { txid: TX_B, vout: 0, address: RECEIVE(19), satoshis: 90_000, height: 0, token: null }, // bigger
];

const reader: ChainReader = { current: () => null, lastError: () => null, refresh: async () => {}, start() {}, stop() {}, onUpdate() {} };

function fakeChain(utxos: Utxo[]) {
  const seen: string[][] = [];
  const chain: Chain = {
    async getUtxos(addresses) {
      seen.push(addresses);
      return utxos.filter((x) => addresses.includes(x.address));
    },
    async getSourceOutput(op) {
      const x = utxos.find((y) => y.txid === op.txid && y.vout === op.vout);
      if (!x) return null;
      const i = Array.from({ length: 20 }, (_, k) => k).find((k) => RECEIVE(k) === x.address);
      if (i === undefined) throw new Error("fake chain: unknown address");
      return {
        lockingBytecode: wallet.lockingBytecode("receive", i),
        valueSatoshis: BigInt(x.satoshis),
        ...(x.token && { token: { category: hexToBin(x.token.category), amount: BigInt(x.token.amount) } }),
      };
    },
    async isUnspentOrSpentBy() {
      return true;
    },
  };
  return { chain, seen };
}

interface FetchCall {
  url: string;
  method: string;
  credentials: RequestCredentials | undefined;
  contentType: string | null;
  cookie: string | null;
}

/** Fake browser fetch: routes to the Hono app and keeps a cookie jar (name → {value, path}). */
function browser(app: ReturnType<typeof createApp>, o: { dropCookies?: boolean } = {}) {
  const jar = new Map<string, { value: string; path: string }>();
  const calls: FetchCall[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), ORIGIN);
    const headers = new Headers(init.headers);
    // a browser adds Origin to every non-GET request
    if ((init.method ?? "GET") !== "GET") headers.set("origin", ORIGIN);
    const cookie = [...jar].filter(([, c]) => url.pathname.startsWith(c.path)).map(([k, c]) => `${k}=${c.value}`).join("; ");
    if (cookie && init.credentials === "include") headers.set("cookie", cookie);
    calls.push({
      url: url.pathname + url.search,
      method: init.method ?? "GET",
      credentials: init.credentials,
      contentType: headers.get("content-type"),
      cookie: headers.get("cookie"),
    });
    const res = await app.request(url.pathname + url.search, { ...init, headers });
    if (!o.dropCookies && init.credentials === "include") {
      for (const sc of res.headers.getSetCookie()) {
        const [pair, ...attrs] = sc.split(";").map((s) => s.trim());
        const eq = pair!.indexOf("=");
        const name = pair!.slice(0, eq);
        const value = pair!.slice(eq + 1);
        const path = attrs.find((a) => a.toLowerCase().startsWith("path="))?.slice(5) ?? "/";
        if (attrs.some((a) => a.toLowerCase() === "max-age=0") || value === "") jar.delete(name);
        else jar.set(name, { value, path });
      }
    }
    return res;
  };
  return { fetch: fetch as typeof globalThis.fetch, jar, calls };
}

interface SignCall {
  transaction: TransactionCommon;
  sourceOutputs: Array<{ lockingBytecode: Uint8Array; valueSatoshis: bigint; outpointIndex: number; outpointTransactionHash: Uint8Array }>;
  broadcast: boolean | undefined;
  userPrompt: string | undefined;
  inputPaths: [number, string, number][];
}

/** Fake DappConnectionManager: wallet-side signing with libauth (SIGHASH_ALL|FORKID, Schnorr). */
function fakeManager(
  w: TestWallet,
  o: { paths?: { name: string; xpub: string }[]; reject?: string; empty?: boolean; signWith?: TestWallet } = {},
) {
  const signCalls: SignCall[] = [];
  const manager: LoginWallet = {
    walletName: "FakeWallet",
    getSessionPaths: () =>
      o.paths ?? [
        { name: "receive", xpub: w.xpubReceive },
        { name: "change", xpub: w.xpubChange },
      ],
    async signTransaction(sent) {
      const req = viaRelay(sent);
      const t = { ...req.transaction, ...decodeRelayRequest(req.transaction) };
      signCalls.push({
        transaction: t.transaction,
        sourceOutputs: t.sourceOutputs as unknown as SignCall["sourceOutputs"],
        broadcast: t.broadcast,
        userPrompt: t.userPrompt,
        inputPaths: req.inputPaths,
      });
      if (o.reject) throw new Error(o.reject);
      if (o.empty) return { signedTransaction: "" } as never;
      const [inputIndex, pathName, index] = req.inputPaths[0]!;
      expect(inputIndex).toBe(0);
      const source = t.sourceOutputs[0]!;
      const signer = o.signWith ?? w;
      const signed = signP2pkhInput0(
        t.transaction as TransactionCommon,
        { lockingBytecode: source.lockingBytecode, valueSatoshis: source.valueSatoshis },
        signer.privateKey(pathName as "receive" | "change", index),
      );
      return { signedTransaction: binToHex(encodeTransaction(signed)) } as never;
    },
  };
  return { manager, signCalls };
}

async function setup(o: { utxos?: Utxo[]; dropCookies?: boolean; skipAge?: boolean } = {}) {
  const { chain, seen } = fakeChain(o.utxos ?? DEFAULT_UTXOS);
  const app = createApp({
    reader,
    db: openDatabase(":memory:"),
    chain,
    secrets: createSecrets("s".repeat(32)),
    config: { loginDomain: DOMAIN, publicOrigin: ORIGIN, trustProxyHops: 0 },
    now: () => NOW,
  });
  const b = browser(app, o);
  // the web app's age screen comes before "Sign in with wallet" (docs/COMPLIANCE.md)
  if (!o.skipAge) {
    const age = await b.fetch("/api/age-check", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dateOfBirth: "1990-05-04" }),
    });
    expect(age.status).toBe(200);
    b.calls.length = 0;
  }
  return { app, seen, ...b };
}

const accountId = binToHex(sha256.hash(utf8ToBin(wallet.xpubReceive)));

async function loginError(p: Promise<unknown>): Promise<LoginError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LoginError);
    return e as LoginError;
  }
  throw new Error("expected wizardLogin to fail");
}

describe("wizardLogin against the real server app", () => {
  it("signs in end to end: smallest plain receive coin, cookies, broadcast:false, /me works afterwards", async () => {
    const s = await setup();
    const { manager, signCalls } = fakeManager(wallet);
    const steps: LoginStep[] = [];
    let signedHex = "";
    const me = await wizardLogin({ manager, fetch: s.fetch, onStep: (st) => steps.push(st), onSigned: (h) => (signedHex = h) });

    expect(me).toEqual<MeResponse>({ accountId, pro: false, proUntil: null, telegramLinked: false, watchLimit: 1 });
    expect(steps).toEqual(["addresses", "utxos", "challenge", "signing", "verifying"]);

    // only the 20 receive addresses are queried
    expect(s.seen).toEqual([Array.from({ length: 20 }, (_, i) => RECEIVE(i))]);

    // the wallet was asked for exactly the login tx, not broadcast, with the final input path
    expect(signCalls).toHaveLength(1);
    const call = signCalls[0]!;
    expect(call.broadcast).toBe(false);
    expect(call.userPrompt).toBe("Sign in to Redline — this will NOT be sent");
    expect(call.inputPaths).toEqual([[0, "receive", 3]]);
    expect(call.transaction.inputs).toHaveLength(1);
    expect(binToHex(call.transaction.inputs[0]!.outpointTransactionHash)).toBe(TX_A);
    expect(call.transaction.inputs[0]!.outpointIndex).toBe(1);
    expect(call.transaction.outputs[1]!.valueSatoshis).toBe(4_000n - BigInt(LOGIN_FEE_SATS));
    expect(call.sourceOutputs).toHaveLength(1);
    expect(binToHex(call.sourceOutputs[0]!.lockingBytecode)).toBe(binToHex(wallet.lockingBytecode("receive", 3)));
    expect(call.sourceOutputs[0]!.valueSatoshis).toBe(4_000n);
    expect(call.sourceOutputs[0]!.outpointIndex).toBe(1);
    expect(signedHex).toMatch(/^[0-9a-f]+$/);

    // browser semantics: credentials on every call, JSON on POSTs, rl_ch carried to verify
    expect(s.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual(["GET /api/utxos", "POST /api/auth/challenge", "POST /api/auth/verify"]);
    for (const c of s.calls) expect(c.credentials).toBe("include");
    for (const c of s.calls.filter((x) => x.method === "POST")) expect(c.contentType).toBe("application/json");
    expect(s.calls[2]!.cookie).toMatch(/rl_ch=[0-9a-f]{64}/);
    expect(s.jar.has("rl_ch")).toBe(false); // cleared by verify
    expect(s.jar.has("rl_session")).toBe(true);

    const meRes = await s.fetch("/api/me", { credentials: "include" });
    expect(meRes.status).toBe(200);
    expect(((await meRes.json()) as MeResponse).accountId).toBe(accountId);
  });

  it("honours apiBase", async () => {
    const s = await setup();
    const { manager } = fakeManager(wallet);
    const fetch = ((url: string, init?: RequestInit) => s.fetch(String(url).replace("https://api.example/x", "/api"), init)) as typeof globalThis.fetch;
    await wizardLogin({ manager, fetch, apiBase: "https://api.example/x" });
    expect(s.calls.map((c) => c.url.split("?")[0])).toEqual(["/api/utxos", "/api/auth/challenge", "/api/auth/verify"]);
  });

  it("no_paths when the wallet shares no receive or change xpub", async () => {
    const s = await setup();
    const e1 = await loginError(wizardLogin({ manager: fakeManager(wallet, { paths: [{ name: "change", xpub: wallet.xpubChange }] }).manager, fetch: s.fetch }));
    expect(e1.code).toBe("no_paths");
    const e2 = await loginError(wizardLogin({ manager: fakeManager(wallet, { paths: [{ name: "receive", xpub: wallet.xpubReceive }] }).manager, fetch: s.fetch }));
    expect(e2.code).toBe("no_paths");
    const e3 = await loginError(
      wizardLogin({ manager: fakeManager(wallet, { paths: [{ name: "receive", xpub: "xpubBAD" }, { name: "change", xpub: wallet.xpubChange }] }).manager, fetch: s.fetch }),
    );
    expect(e3.code).toBe("no_paths");
    expect(s.calls).toHaveLength(0);
  });

  it("no_funds names receive address 0 and does not ask the wallet to sign", async () => {
    const s = await setup({ utxos: DEFAULT_UTXOS.filter((x) => x.satoshis < 2_000 || x.token) });
    const { manager, signCalls } = fakeManager(wallet);
    const e = await loginError(wizardLogin({ manager, fetch: s.fetch }));
    expect(e.code).toBe("no_funds");
    expect(e.message).toContain("Send at least 2,000 sats");
    expect(e.message).toContain(RECEIVE(0));
    expect(e.address).toBe(RECEIVE(0));
    expect(signCalls).toHaveLength(0);
  });

  it("wallet_rejected keeps the wallet's own message", async () => {
    const s = await setup();
    const e = await loginError(wizardLogin({ manager: fakeManager(wallet, { reject: "User declined the request" }).manager, fetch: s.fetch }));
    expect(e.code).toBe("wallet_rejected");
    expect(e.message).toContain("User declined the request");
    expect(s.calls.map((c) => c.url.split("?")[0])).toEqual(["/api/utxos", "/api/auth/challenge"]);
  });

  it("wallet_rejected on an empty signature", async () => {
    const s = await setup();
    const e = await loginError(wizardLogin({ manager: fakeManager(wallet, { empty: true }).manager, fetch: s.fetch }));
    expect(e.code).toBe("wallet_rejected");
  });

  it("server_rejected carries the server's error code and message", async () => {
    const s = await setup();
    const e = await loginError(wizardLogin({ manager: fakeManager(wallet, { signWith: other }).manager, fetch: s.fetch }));
    expect(e.code).toBe("server_rejected");
    expect(e.serverCode).toBe("login_invalid");
    expect(e.status).toBe(422);
    expect(e.message).toContain("bad_signature");
  });

  it("server_rejected (age_required) when the age screen was skipped", async () => {
    const s = await setup({ skipAge: true });
    const e = await loginError(wizardLogin({ manager: fakeManager(wallet).manager, fetch: s.fetch }));
    expect(e.code).toBe("server_rejected");
    expect(e.serverCode).toBe("age_required");
  });

  it("server_rejected (challenge_mismatch) when the browser does not keep the rl_ch cookie", async () => {
    const s = await setup({ skipAge: true, dropCookies: true });
    // pass the age screen with cookies kept, then lose them for the sign-in
    const age = await s.app.request("/api/age-check", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ dateOfBirth: "1990-05-04" }),
    });
    const ageCookie = age.headers.getSetCookie()[0]!.split(";")[0]!;
    const fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", ageCookie);
      return s.fetch(input, { ...init, headers });
    }) as typeof globalThis.fetch;
    const e = await loginError(wizardLogin({ manager: fakeManager(wallet).manager, fetch }));
    expect(e.code).toBe("server_rejected");
    expect(e.serverCode).toBe("challenge_mismatch");
  });

  it("network when fetch itself fails", async () => {
    const fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof globalThis.fetch;
    const e = await loginError(wizardLogin({ manager: fakeManager(wallet).manager, fetch }));
    expect(e.code).toBe("network");
    expect(e.message).toContain("Failed to fetch");
  });

  it("network when the server answers with something that is not JSON", async () => {
    const fetch = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof globalThis.fetch;
    const e = await loginError(wizardLogin({ manager: fakeManager(wallet).manager, fetch }));
    expect(e.code).toBe("network");
    expect(e.status).toBe(502);
  });

  it("an aborted signal stops the login with the AbortError (not a LoginError)", async () => {
    const s = await setup();
    const ac = new AbortController();
    ac.abort();
    await expect(wizardLogin({ manager: fakeManager(wallet).manager, fetch: s.fetch, signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
