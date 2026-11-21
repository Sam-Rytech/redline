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
Serves live ParyonUSD loans from BCH mainnet, refreshed every 60 s, plus the age screen, wallet sign-in, `/api/me`, `/api/me/loans`, `DELETE /api/me` and `/api/utxos`. Watches, Telegram and invoices are not built on the real server yet (404 `not_found`); use the mock for those screens.

Every POST, PATCH and DELETE must send `Origin` equal to the server's `PUBLIC_ORIGIN` (a browser does this itself) and, except DELETE, `Content-Type: application/json` (also for logout: send `{}`). Locally `PUBLIC_ORIGIN` defaults to `http://localhost:5173`.

- For the first few seconds after start, `/api/loans` and `/api/loans/:id` return 503 `{ "error": { "code": "not_ready", ... } }`. Show a loading state and retry.
- Loans come sorted riskiest first (stranded loans last).
- `GET /api/health` always returns 200: `{ ok, blockHeight, updatedAt, stale, lastError }`. `stale` is true when there is no data yet or it is older than 5 minutes; `lastError` is the last failed refresh (the previous good data keeps being served).

## Endpoints

Note: `LoansResponse.summary.strandedCount` / `strandedBch` count loans with debt 0 that still hold collateral (fully redeemed, unclaimed) and their total collateral in BCH.
`summary.total` counts every loan output, stranded ones included. For the "N active loans" and "Total Collateral" figures that stats.paryonusd.com shows, use `summary.activeCount` and `summary.activeCollateralBch` (loans with debt above 0).
`LoanView.paryonUrl` is `https://paryonusd.com/app` for every loan; the Paryon dApp has no per-loan links.
`LoanView.claimUrl` is the same link for a stranded loan and `null` for every other loan: the owner claims the leftover BCH by closing the loan with its loan key in the Paryon app (gate GL2).

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | /api/health | – | `{ ok: true }` |
| GET | /api/loans | – | `LoansResponse` |
| GET | /api/loans/:id | – | `LoanView` / 404 |
| POST | /api/age-check | – | `{ ok: true }` + `rl_age` cookie, or 403 `age_blocked` |
| POST | /api/auth/challenge | age | `ChallengeResponse` + `rl_ch` cookie |
| POST | /api/auth/verify | `rl_ch` | `MeResponse` + `rl_session` cookie |
| POST | /api/auth/logout | – | `{ ok: true }` |
| GET | /api/utxos?addresses=a,b | – | `Utxo[]` |
| GET | /api/me | ✓ | `MeResponse` |
| DELETE | /api/me | ✓ | `{ ok: true }`: removes the account, sessions, watches, alert history, invoices and Telegram link |
| GET | /api/me/loans | ✓ | `LoanView[]` |
| GET/POST | /api/watches | ✓ | `Watch[]` / `Watch` (201) — 403 `watch_limit` on free plan, 409 `watch_exists` if already watched |
| PATCH/DELETE | /api/watches/:id | ✓ | `Watch` / `{ ok: true }` |
| POST | /api/telegram/link-token | ✓ | `TelegramLinkResponse` |
| GET | /api/invoices/quote | ✓ | `InvoiceQuote` |
| POST | /api/invoices | ✓ | `Invoice` (201) |
| GET | /api/invoices/:id | ✓ | `Invoice` |
| POST | /api/invoices/:id/submit | ✓ | `Invoice` |

API errors use this envelope: `{ "error": { "code": "...", "message": "..." } }`. Codes are listed under "Error codes" below.

## Request bodies

- `POST /api/age-check`: `{ dateOfBirth: "YYYY-MM-DD" }` (never stored)
- `POST /api/auth/challenge`: `{ outpoint: { txid, vout }, path: ["receive", index] }`. Only receive-path coins sign in.
- `POST /api/auth/verify`: `{ signedTxHex, xpubReceive, xpubChange }`. The xpubs are kept only inside the encrypted session.
- `POST /api/auth/logout`: `{}`
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

## Error codes

All errors use the envelope above. Every code below is returned by the real server today, except
`watch_limit` and `watch_exists` (watches are not on the real server yet).

| Status | Code | When |
|---|---|---|
| 400 | `bad_request` | body fails validation |
| 400 | `bad_path` | sign-in coin is not on a receive path |
| 401 | `unauthorized` | no or expired session |
| 403 | `age_blocked` | age screen failed (remembered; changing the date does not pass) |
| 403 | `age_required` | `/auth/challenge` before the age screen passed |
| 403 | `forbidden_origin` | a state-changing request whose `Origin` is not ours, or not JSON |
| 403 | `challenge_mismatch` | `/auth/verify` came from a different browser than `/auth/challenge` |
| 403 | `watch_limit` | free plan already has its watch |
| 404 | `not_found` | unknown route or loan |
| 409 | `watch_exists` | loan already watched |
| 410 | `challenge_expired` / `challenge_used` | nonce older than 5 minutes or already used |
| 413 | `too_large` | body over 16 KB |
| 422 | `login_invalid` | signed transaction fails verification; the message starts with the reason, e.g. `wrong_address: ...` |
| 429 | `rate_limited` | see `SECURITY.md` for limits |
| 503 | `not_ready` | chain data not loaded yet |
| 503 | `chain_unavailable` | the BCH network could not be reached; try again |

## Planned contract changes (not yet in `api-types`)

Each becomes a type change, announced in the team chat, when it is built.

| Change | Why |
|---|---|
| `LoansResponse.stale: boolean` and `dataAgeSeconds: number` | the data can be old and the screen must say so; alerts are not sent from stale data |
| `Invoice` response adds `terms: { priceUsd, days: 30, renews: false }` | the pay button shows the terms beside it |

## Mock-only behaviour

- Sign-in without a wallet: `POST /api/age-check` with an adult date, then `POST /api/auth/challenge` (any outpoint), then `POST /api/auth/verify` with `{ "signedTxHex": "00" }` from the same browser. The order and the cookies (`rl_age`, `rl_ch`) work like the real server; the mock does not check the signature or the Origin.
- `GET /api/me/loans` returns 3 loans: critical, watch, stranded.
- Submitting an invoice marks it paid and turns on Pro (watch limit becomes unlimited).
- `GET /api/mock/telegram-linked` marks Telegram as connected (requires sign-in, like other non-public routes).
- State resets when the mock restarts.

## Sign-in (front end)

The wallet connects over WizardConnect; `packages/wizard-login` does the protocol.

```ts
import { connectWallet, wizardLogin, LoginError } from "@redline/wizard-login/client";

// after the age screen passed (POST /api/age-check)
const conn = connectWallet({ dappName: "Redline" });
showQr(conn.qrUri);                 // render as a QR code; on a phone, link to it
await conn.ready;                   // the wallet scanned and approved
try {
  const me = await wizardLogin({ manager: conn.manager, onStep: (s) => setStep(s) });
} catch (e) {
  if (e instanceof LoginError) show(e.code, e.message); // no_paths, no_funds, wallet_rejected, server_rejected, network
}
```

`no_funds` means the wallet has no plain BCH coin of at least 2,000 sats on its first 20 receive
addresses; the error carries `address` (receive address 0) to show for a top-up.

Test page with a real wallet: `pnpm dev:server` with `PUBLIC_ORIGIN=http://localhost:5174`, and
`pnpm dev:login`, then open http://localhost:5174.
