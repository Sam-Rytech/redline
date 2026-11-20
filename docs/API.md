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

Env: `LOGIN_DOMAIN` (default `localhost`; must match what the client puts in the login tx), `DB_PATH` (default `./data/redline.db`), `NODE_ENV=production` adds `Secure` to the cookie. Node prints a one-line SQLite `ExperimentalWarning` at start; harmless.

- For the first few seconds after start, `/api/loans` and `/api/loans/:id` return 503 `{ "error": { "code": "not_ready", ... } }`. Show a loading state and retry.
- Loans come sorted riskiest first (stranded loans last).
- `GET /api/health` always returns 200: `{ ok, blockHeight, updatedAt, stale, lastError }`. `stale` is true when there is no data yet or it is older than 5 minutes; `lastError` is the last failed refresh (the previous good data keeps being served).

### Wallet sign-in (real server)

Full protocol: ARCHITECTURE.md §3.1. Code: `packages/wizard-login` (`protocol.ts` shared, `server/` verification). The browser helper that drives WizardConnect is coming next; until then the format below is what it must produce (`buildUnsignedLoginTx` builds it).

1. Get the wallet's `receive`/`change` xpubs, list UTXOs with `GET /api/utxos`, pick the smallest pure-BCH UTXO ≥ 2,000 sats.
2. `POST /api/auth/challenge` `ChallengeRequest` → `ChallengeResponse { nonce, expiry, domain }` (valid 300 s, single use). 400 `bad_request` / `bad_xpub`.
3. Build and have the wallet sign (not broadcast) the login tx:
   - version 2, locktime 0, exactly 1 input = the challenge outpoint (sequence `0xffffffff`);
   - output 0: value 0, `OP_RETURN` + 4 minimal pushes: `"WZL1"` | domain (utf-8) | nonce (16 bytes) | expiry (uint32 LE);
   - output 1: same locking bytecode as the spent output, value = input − fee (client uses 400; server accepts 200–2,000); no tokens anywhere.
4. `POST /api/auth/verify { signedTxHex }` → `MeResponse` + `Set-Cookie: rl_session=…; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`. The server fetches the spent output from Electrum itself and runs the full libauth VM. Failures are 401 with one of: `bad_tx`, `bad_domain`, `unknown_nonce`, `outpoint_mismatch`, `expired`, `nonce_used`, `source_missing`, `wrong_address`, `bad_fee`, `bad_signature`, `spent`. 503 `chain_unavailable` if Electrum is down.
5. `GET /api/me` → `MeResponse` (401 `unauthorized` without a session). `POST /api/auth/logout` → `{ ok: true }` and clears the cookie.

- `GET /api/me/loans` → `LoanView[]`: loans whose id matches a **minting** NFT category held on receive/change addresses 0–19 (cached 60 s per account). 401 without a session, 503 `not_ready` before the first chain refresh.
- `GET /api/utxos?addresses=a,b` → `Utxo[]` (with token data). 1–60 `bitcoincash:` addresses, else 400 `bad_request`.
- `/api/auth/*` and `/api/utxos` share a limit of 30 requests/min per IP → 429 `rate_limited`.

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

## Real sign-in (later)

The Sign in screen will call `wizardLogin({ manager, apiBase: "/api", domain })` from `packages/wizard-login` (not created yet); it returns a `MeResponse`. Until then, use the mock shortcut above.
