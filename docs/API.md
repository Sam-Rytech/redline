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
Serves live ParyonUSD loans from BCH mainnet, refreshed every 60 s. Only `GET /api/loans`, `GET /api/loans/:id` and `GET /api/health` exist so far; every other `/api/*` path returns 404 `not_found` (auth, watches, Telegram and invoices still need the mock).

- For the first few seconds after start, `/api/loans` and `/api/loans/:id` return 503 `{ "error": { "code": "not_ready", ... } }`. Show a loading state and retry.
- Loans come sorted riskiest first (stranded loans last).
- `GET /api/health` always returns 200: `{ ok, blockHeight, updatedAt, stale, lastError }`. `stale` is true when there is no data yet or it is older than 5 minutes; `lastError` is the last failed refresh (the previous good data keeps being served).

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
