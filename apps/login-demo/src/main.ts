import "./style.css";
import QRCode from "qrcode";
import type { ApiError, MeResponse } from "@redline/api-types";
import {
  LoginError,
  connectWallet,
  deriveAddresses,
  txidOf,
  wizardLogin,
  type WalletConnection,
} from "@redline/wizard-login/client";

const API = "/api";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const ui = {
  connect: $<HTMLButtonElement>("connect"),
  disconnect: $<HTMLButtonElement>("disconnect"),
  status: $("status"),
  pairing: $("pairing"),
  qr: $<HTMLCanvasElement>("qr"),
  uri: $<HTMLAnchorElement>("uri"),
  copy: $<HTMLButtonElement>("copy"),
  ready: $("ready"),
  addr0: $("addr0"),
  signin: $<HTMLButtonElement>("signin"),
  me: $<HTMLButtonElement>("me"),
  logout: $<HTMLButtonElement>("logout"),
  result: $("result"),
  meJson: $("me-json"),
  txid: $("txid"),
  g1: $("g1"),
  dob: $<HTMLInputElement>("dob"),
  age: $<HTMLButtonElement>("age"),
  ageStatus: $("age-status"),
  log: $("log"),
};

function log(line: string) {
  const t = new Date().toLocaleTimeString(undefined, { hour12: false });
  ui.log.textContent = `${t}  ${line}\n${ui.log.textContent ?? ""}`;
}
const describe = (e: unknown) =>
  e instanceof LoginError ? `[${e.code}] ${e.message}` : e instanceof Error ? `${e.name}: ${e.message}` : String(e);

let conn: WalletConnection | null = null;
let signing: AbortController | null = null;

function setStatus(text: string) {
  ui.status.textContent = text;
  log(`status: ${text}`);
}

function resetWalletUi() {
  ui.pairing.hidden = true;
  ui.ready.hidden = true;
  ui.connect.disabled = false;
  ui.disconnect.disabled = true;
  ui.signin.disabled = false;
}

async function disconnect(reason: string) {
  signing?.abort(new Error("Wallet disconnected"));
  signing = null;
  const c = conn;
  conn = null;
  resetWalletUi();
  if (c) {
    try {
      await c.close();
    } catch (e) {
      log(`close: ${describe(e)}`);
    }
  }
  setStatus(reason);
}

ui.connect.addEventListener("click", async () => {
  if (conn) return;
  ui.connect.disabled = true;
  ui.disconnect.disabled = false;
  ui.result.hidden = true;
  let c: WalletConnection;
  let walletReady = false;
  let relayStatus = "";
  try {
    c = connectWallet({
      dappName: "Redline (demo)",
      onRelayStatus: (status, error) => {
        if (status === relayStatus) return;
        relayStatus = status;
        log(`relay: ${status}${error ? ` (${error})` : ""}`);
        if (conn !== c) return;
        if (status === "reconnecting") setStatus(`reconnecting to ${walletReady ? (c.walletName() ?? "wallet") : "relay"}…`);
        else if (status === "connected") setStatus(walletReady ? `connected to ${c.walletName() ?? "wallet"}` : "waiting for wallet — scan the QR code");
      },
    });
  } catch (e) {
    log(`connect failed: ${describe(e)}`);
    resetWalletUi();
    return;
  }
  conn = c;
  ui.uri.href = c.qrUri;
  ui.uri.textContent = "the pairing link";
  ui.pairing.hidden = false;
  try {
    await QRCode.toCanvas(ui.qr, c.qrUri, { width: 280, margin: 1, errorCorrectionLevel: "M" });
  } catch (e) {
    log(`QR render failed: ${describe(e)}`);
  }
  setStatus("waiting for wallet — scan the QR code");
  c.manager.on("walletready", (msg) => {
    walletReady = true;
    if (conn !== c) return;
    setStatus(`connected to ${c.walletName() ?? "wallet"}`);
    // Debug summary of what the wallet sent (xpubs truncated). Wallets may send
    // wallet_ready more than once (e.g. first before the user approves), so
    // re-read the paths every time.
    const m = msg as unknown as { supported_protocols?: string[]; session?: Record<string, { paths?: { name: string; xpub: string }[] }> };
    const sessions = Object.entries(m.session ?? {}).map(
      ([proto, s]) => `${proto}: [${(s?.paths ?? []).map((p) => `${p.name}=${String(p.xpub).slice(0, 12)}…`).join(", ")}]`,
    );
    log(`wallet_ready: protocols ${JSON.stringify(m.supported_protocols ?? [])}; ${sessions.join("; ") || "no session data"}`);
    showPaths();
  });
  c.manager.on("disconnect", (reason, message) => {
    if (conn === c) void disconnect(`disconnected by wallet (${reason}${message ? `: ${message}` : ""})`);
  });
  try {
    await c.ready;
  } catch (e) {
    if (conn === c) log(`wallet not ready: ${describe(e)}`);
    return;
  }
  if (conn !== c) return;
  ui.pairing.hidden = true;
  showPaths();
  ui.ready.hidden = false;
});

function showPaths(): void {
  const c = conn;
  if (!c) return;
  const paths = c.manager.getSessionPaths();
  const receive = paths.find((p) => p.name === "receive");
  try {
    ui.addr0.textContent = receive
      ? (deriveAddresses(receive.xpub, 1)[0] ?? "?")
      : "(wallet shared no receive path yet — approve the connection in the wallet)";
  } catch (e) {
    ui.addr0.textContent = `(bad receive xpub: ${describe(e)})`;
  }
  log(`paths shared: ${paths.map((p) => p.name).join(", ") || "(none)"}`);
}

ui.copy.addEventListener("click", async () => {
  if (!conn) return;
  try {
    await navigator.clipboard.writeText(conn.qrUri);
    log("pairing URI copied");
  } catch {
    log("copy failed — use the link above"); // never log the pairing URI
  }
});

ui.disconnect.addEventListener("click", () => void disconnect("disconnected"));

ui.signin.addEventListener("click", async () => {
  if (!conn || signing) return;
  const c = conn;
  ui.signin.disabled = true;
  ui.result.hidden = true;
  const ctrl = new AbortController();
  signing = ctrl;
  let txid: string | null = null;
  try {
    const me = await wizardLogin({
      manager: c.manager,
      apiBase: API,
      signal: ctrl.signal,
      onStep: (step, detail) => log(`step ${step}${detail ? ` — ${detail}` : ""}`),
      onSigned: (hex) => {
        txid = txidOf(hex);
        log(`wallet signed: txid ${txid} (${hex.length / 2} bytes)`);
      },
    });
    log("signed in");
    showResult(me, txid);
  } catch (e) {
    log(ctrl.signal.aborted ? "Sign-in cancelled (wallet disconnected)" : `sign-in failed: ${describe(e)}`);
    if (txid) showResult(null, txid);
  } finally {
    signing = null;
    ui.signin.disabled = false;
  }
});

function showResult(me: MeResponse | null, txid: string | null) {
  ui.result.hidden = false;
  ui.meJson.textContent = me ? JSON.stringify(me, null, 2) : "(not signed in)";
  ui.txid.textContent = txid ?? "(none)";
  ui.g1.textContent = "";
  if (txid) {
    const url = `https://blockchair.com/bitcoin-cash/transaction/${txid}`;
    ui.g1.append("Check whether this txid appears on an explorer within 2 min → ");
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = url;
    ui.g1.append(a, " (G1: did the wallet broadcast it?)");
  }
}

async function call(method: "GET" | "POST", path: string) {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      credentials: "include",
      ...(method === "POST" && { headers: { "Content-Type": "application/json" }, body: "{}" }),
    });
    const text = await res.text();
    let shown = text;
    try {
      const body = JSON.parse(text) as unknown;
      shown = JSON.stringify(body);
      const err = (body as Partial<ApiError>).error;
      if (!res.ok && err) shown = `${err.code}: ${err.message}`;
    } catch {
      // not JSON: show raw text
    }
    log(`${method} ${API}${path} → ${res.status} ${shown}`);
  } catch (e) {
    log(`${method} ${API}${path} failed: ${describe(e)}`);
  }
}

// The age screen comes before sign-in (docs/COMPLIANCE.md). The server keeps the result in the
// HttpOnly rl_age cookie; the date itself is not stored.
ui.age.addEventListener("click", async () => {
  ui.age.disabled = true;
  try {
    const res = await fetch(`${API}/age-check`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dateOfBirth: ui.dob.value }),
    });
    const body = (await res.json()) as Partial<ApiError>;
    ui.ageStatus.textContent = res.ok ? "confirmed" : `${body.error?.code}: ${body.error?.message}`;
    log(`age check → ${res.status} ${ui.ageStatus.textContent}`);
  } catch (e) {
    log(`age check failed: ${describe(e)}`);
  } finally {
    ui.age.disabled = false;
  }
});

ui.me.addEventListener("click", () => void call("GET", "/me"));
ui.logout.addEventListener("click", () => void call("POST", "/auth/logout"));

window.addEventListener("pagehide", () => {
  void conn?.close();
});

log("ready — click Connect wallet");
