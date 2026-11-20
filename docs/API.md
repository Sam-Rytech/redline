# Redline API (for the front end)

Types: `packages/api-types/src/index.ts` — import with `import type { … } from "@redline/api-types"`.
All routes are under `/api`. Always call relative URLs (`fetch("/api/loans", { credentials: "include" })`).

## Run the mock

```bash
pnpm install
pnpm dev:mock          # http://localhost:8787/api
```
Requires Node >= 22.12.

Vite proxy (`apps/web/vite.config.ts`, once the web app exists):
```ts
server: { proxy: { "/api": "http://localhost:8787" } }
```
Production: Vercel rewrites `/api/:path*` to the Railway server, so cookies stay same-origin.

## Real server

```bash
pnpm dev:server        # http://localhost:8787/api  (stop the mock first: same port)
```
Serves live ParyonUSD loans from BCH mainnet, refreshed every 60 s. Real routes so far: `GET /api/health`, `GET /api/loans`, `GET /api/loans/:id`, `POST /api/auth/challenge`, `POST /api/auth/verify`, `POST /api/auth/logout`, `GET /api/me`, `GET /api/me/loans`, `GET /api/utxos`. Every other `/api/*` path returns 404 `not_found` (watches, Telegram and invoices still need the mock).

Env: `LOGIN_DOMAIN` (default `localhost`; must match what the client puts in the login tx), `DB_PATH` (default `./data/redline.db`), `COOKIE_SECURE` (cookies are `Secure` by default, which works on `http://localhost`; set `false` only for plain-http testing on another host), `TRUST_PROXY_HOPS` (integer >= 0, default 0 = rate limit by socket address; N = the Nth `x-forwarded-for` entry from the right, 1 = right-most; fewer entries than N falls back to the left-most; legacy `TRUST_PROXY=true` means 1; an invalid value fails at start). Behind Vercel rewrite -> Railway, set `TRUST_PROXY_HOPS` after checking the real header chain on staging (log it once with `LOG_XFF=1`, which logs the raw `x-forwarded-for` of the first 5 `/api/auth` requests, never more), `PUBLIC_ORIGIN` (e.g. `https://redline.app`; when set, every POST must send that exact `Origin`). Node prints a one-line SQLite `ExperimentalWarning` at start; harmless.

- For the first few seconds after start, `/api/loans` and `/api/loans/:id` return 503 `{ "error": { "code": "not_ready", ... } }`. Show a loading state and retry.
- Loans come sorted riskiest first (stranded loans last).
- `GET /api/health` always returns 200: `{ ok, blockHeight, updatedAt, stale, lastError }`. `stale` is true when there is no data yet or it is older than 5 minutes; `lastError` is the last failed refresh (the previous good data keeps being served).

### Wallet sign-in (real server)

Full protocol: ARCHITECTURE.md §3.1. Code: `packages/wizard-login` (`protocol.ts` shared, `server/` verification). The browser helper `wizardLogin` (see **Sign-in (front end)** below) does all of this for you; the steps are listed for reference (`buildUnsignedLoginTx` builds the tx).

Every POST must send `Content-Type: application/json` (else 415 `bad_content_type`), a body ≤ 32 KB (else 413 `too_large`), and when `PUBLIC_ORIGIN` is set a matching `Origin` (else 403 `bad_origin`). Use `credentials: "include"` so the cookies flow. Always send the JSON content type, including `POST /api/auth/logout` with body `{}` (a bodyless fetch sends no content type and gets 415). The mock enforces this too, so the front end behaves the same against both.

1. Get the wallet's `receive`/`change` xpubs (mainnet), list the **receive** addresses' UTXOs with `GET /api/utxos`, pick the smallest token-free UTXO ≥ 2,000 sats on the receive path.
2. `POST /api/auth/challenge` `ChallengeRequest` (`path: ["receive", index]`) → `ChallengeResponse { nonce, expiry, domain }` (valid 300 s, single use) plus an HttpOnly `rl_chal` cookie binding the challenge to this browser. 400 `bad_request` / `bad_xpub` (invalid, non-mainnet, or receive = change) / `bad_path` (not the receive path).
3. Build and have the wallet sign (not broadcast) the login tx:
   - version 2, locktime 0, exactly 1 input = the challenge outpoint (sequence `0xffffffff`);
   - output 0: value 0, `OP_RETURN` + 4 minimal pushes: `"WZL1"` | domain (utf-8) | nonce (16 bytes) | expiry (uint32 LE);
   - output 1: same locking bytecode as the spent output, value = input − fee (client uses 400; server accepts 200–2,000); no tokens anywhere;
   - input 0 signed P2PKH with **SIGHASH_ALL|FORKID (0x41)**; other sighash types are refused.
4. `POST /api/auth/verify { signedTxHex }` from the same browser (sends `rl_chal`, which is then cleared) → `MeResponse` + `Set-Cookie: rl_session=…; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`. The server fetches the spent output from Electrum itself and runs the full libauth VM. Failures are 401 with one of: `bad_tx`, `bad_domain`, `unknown_nonce`, `challenge_not_bound`, `outpoint_mismatch`, `expired`, `nonce_used`, `source_missing`, `token_source`, `source_too_small`, `wrong_address`, `bad_fee`, `bad_signature`, `spent`. Any failure needs a new challenge. 503 `chain_unavailable` if Electrum is down.
5. `GET /api/me` → `MeResponse` (401 `unauthorized` without a session). `POST /api/auth/logout` → `{ ok: true }` and clears the cookie.

- `GET /api/me/loans` → `LoanView[]`: loans whose id matches a **minting** NFT category held on receive/change addresses 0–19 (cached 60 s per account). 401 without a session, 503 `not_ready` before the first chain refresh.
- `GET /api/utxos?addresses=a,b` → `Utxo[]` (with token data). 1–60 `bitcoincash:` addresses, else 400 `bad_request`.
- `/api/auth/*` and `/api/utxos` share a limit of 30 requests/min per client IP → 429 `rate_limited`.

## Sign-in (front end)

Import from `@redline/wizard-login/client` (workspace package; pins `@wizardconnect/dapp` 0.2.8 + `@wizardconnect/core` 0.2.11):

```ts
import { connectWallet, wizardLogin, LoginError } from "@redline/wizard-login/client";

const conn = connectWallet();                // { qrUri, ready, manager, walletName(), close() }
showQr(conn.qrUri);                          // QR for a phone wallet, or <a href={conn.qrUri}> on the same device
await conn.ready;                            // wallet shared its xpubs (rejects if it disconnects first)
try {
  const me = await wizardLogin({ manager: conn.manager, onStep: (s, d) => console.log(s, d) });
  // signed in: rl_session cookie is set, `me` is the MeResponse
} catch (e) {
  if (e instanceof LoginError) show(e.code, e.message); // show the full message; e.address for no_funds
}
await conn.close();                          // when the user disconnects
```

- Options: `apiBase` (default `"/api"`), `signal` (AbortSignal; an abort rejects with the AbortError, not a LoginError), `onStep(step, detail)` with steps `addresses → utxos → challenge → signing → verifying`, `onSigned(txHex)` (the wallet's signed login tx; `txidOf(hex)` gives its id), `fetch` (for tests). All requests use `credentials: "include"` — the API must be same-origin (Vite proxy / Vercel rewrite).
- `LoginError.code`:
  - `no_paths` — the wallet did not share usable `receive` + `change` xpubs.
  - `no_funds` — no token-free coin ≥ 2,000 sats on receive addresses 0–19. The message tells the user to send 2,000 sats and includes receive address 0 (also `e.address`).
  - `wallet_rejected` — the wallet refused or failed to sign (its own message is kept). Do not auto-retry with another wallet.
  - `server_rejected` — the server said no; message is `"<error.code>: <message>"`, also `e.serverCode` and `e.status` (e.g. `bad_signature`, `rate_limited`, `chain_unavailable`).
  - `network` — the server could not be reached or did not answer JSON.
- `connectWallet({ dappName, dappIcon, onRelayStatus })`: `dappName` defaults to `"Redline"`; no session persistence in v1 (a page reload needs a new pairing). `manager` emits `walletready`, `disconnect`, `reconnecting`.
- The server's `LOGIN_DOMAIN` must equal the site's host in production (the client copies `domain` from the challenge into the login tx).

### Demo page (real wallets)

```bash
pnpm dev:server        # real server on :8787
pnpm dev:login         # http://localhost:5174 (proxies /api to :8787)
```
Open http://localhost:5174, click **Connect wallet**, scan with Paytaca or Selene, then **Sign in**. The page logs every step with timestamps, shows the `MeResponse`, the login txid and a Blockchair link to check whether the wallet broadcast it (it should not). Buttons: GET /me, Log out, Disconnect wallet. The wallet needs a plain coin of ≥ 2,000 sats on one of its first 20 receive addresses.

## Endpoints

Note: `LoansResponse.summary.strandedCount` / `strandedBch` count loans with debt 0 that still hold collateral (fully redeemed, unclaimed) and their total collateral in BCH.

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | /api/health | – | `{ ok: true }` |
| GET | /api/loans | – | `LoansResponse` |
| GET | /api/loans/:id | – | `LoanView` / 404 |
| POST | /api/auth/challenge | – | `ChallengeResponse` |
| POST | /api/auth/verify | – | `MeResponse` + session cookie |
| POST | /api/auth/logout | – | `{ ok: true }` |
| GET | /api/utxos?addresses=a,b | – | `Utxo[]` |
| GET | /api/me | ✓ | `MeResponse` |
| GET | /api/me/loans | ✓ | `LoanView[]` |
| GET/POST | /api/watches | ✓ | `Watch[]` / `Watch` (201) — 403 `watch_limit` on free plan, 409 `watch_exists` if already watched |
| PATCH/DELETE | /api/watches/:id | ✓ | `Watch` / `{ ok: true }` |
| POST | /api/telegram/link-token | ✓ | `TelegramLinkResponse` |
| GET | /api/invoices/quote | ✓ | `InvoiceQuote` |
| POST | /api/invoices | ✓ | `Invoice` (201) |
| GET | /api/invoices/:id | ✓ | `Invoice` |
| POST | /api/invoices/:id/submit | ✓ | `Invoice` |

API errors use this envelope: `{ "error": { "code": "...", "message": "..." } }` (401 `unauthorized`, 403 `watch_limit`, 404 `not_found`, 409 `watch_exists`, 400 `bad_request`).

## Request bodies

- `POST /api/auth/challenge`: `ChallengeRequest`
- `POST /api/auth/verify`: `{ signedTxHex }`
- `POST /api/watches`: `{ loanId, rules? }`
- `PATCH /api/watches/:id`: `{ rules }`
- `POST /api/invoices`: `{ asset: "BCH", inputs: Outpoint[] }` (inputs non-empty)
- `POST /api/invoices/:id/submit`: `{ signedTxHex }`

## Pro pass payment flow

1. `GET /api/invoices/quote` for `amountSats` and the merchant address.
2. Pick inputs worth at least `amountSats` + fee.
3. `POST /api/invoices` with those inputs.
4. Sign with `broadcast: true`.
5. `POST /api/invoices/:id/submit` with the signed tx.

Store the invoice id in localStorage so a reload can `GET /api/invoices/:id` and show "Already paid ✓".

## Mock-only behaviour

- `POST /api/auth/verify` with any `{ "signedTxHex": "00" }` signs you in — no wallet needed.
- `GET /api/me/loans` returns 3 loans: critical, watch, stranded.
- Submitting an invoice marks it paid and turns on Pro (watch limit becomes unlimited).
- `GET /api/mock/telegram-linked` marks Telegram as connected (requires sign-in, like other non-public routes).
- State resets when the mock restarts.
