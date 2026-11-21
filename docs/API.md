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
Production: Vercel rewrites `/api/:path*` to the server on Fly.io, so cookies stay same-origin.

## Real server

```bash
pnpm dev:server        # http://localhost:8787/api  (stop the mock first: same port)
```
Serves live ParyonUSD loans from BCH mainnet, refreshed every 60 s, plus the age screen, wallet sign-in, `/api/me`, `/api/me/loans`, `DELETE /api/me`, `/api/utxos`, watches, Telegram linking and the Pro pass invoices. Telegram linking answers 503 `telegram_unavailable` while the server has no `TELEGRAM_BOT_TOKEN`; invoice routes answer 503 `payments_unavailable` while it has no `MERCHANT_ADDRESS`.

Every POST, PATCH and DELETE must send `Origin` equal to the server's `PUBLIC_ORIGIN` (a browser does this itself) and, except DELETE, `Content-Type: application/json` (also for logout: send `{}`). Locally `PUBLIC_ORIGIN` defaults to `http://localhost:5173`.

- For the first few seconds after start, `/api/loans` and `/api/loans/:id` return 503 `{ "error": { "code": "not_ready", ... } }`. Show a loading state and retry.
- Loans come sorted riskiest first (stranded loans last).
- `GET /api/health` always returns 200: `{ ok, blockHeight, updatedAt, stale, lastError, missingSidecars }`. `stale` is true when there is no data yet or it is older than 5 minutes; `lastError` is the last failed refresh (the previous good data keeps being served); `missingSidecars` counts loan outputs read without their sidecar.
- `GET /api/loans` carries `stale` and `dataAgeSeconds`. Show the age when it is stale (PRD R3). A read missing more than 20% of the loans, or from a server behind the last block, is discarded and the previous data stays.

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
| GET | /api/me | yes | `MeResponse` |
| DELETE | /api/me | yes | `{ ok: true }`: removes the account, sessions, watches, alert history, invoices and Telegram link |
| GET | /api/me/loans | yes | `LoanView[]` |
| GET/POST | /api/watches | yes | `Watch[]` / `Watch` (201) — 403 `watch_limit` on free plan, 409 `watch_exists` if already watched |
| PATCH/DELETE | /api/watches/:id | yes | `Watch` / `{ ok: true }` |
| POST | /api/telegram/link-token | yes | `TelegramLinkResponse`: open `url` to link the chat; the token is single use and lasts 10 minutes |
| POST | /api/telegram/unlink | yes | `{ ok: true }` |
| GET | /api/invoices/quote | yes | `InvoiceQuote` |
| POST | /api/invoices | yes | `Invoice` (201) |
| GET | /api/invoices/:id | yes | `Invoice` |
| POST | /api/invoices/:id/submit | yes | `Invoice` |

API errors use this envelope: `{ "error": { "code": "...", "message": "..." } }`. Codes are listed under "Error codes" below.

## Request bodies

- `POST /api/age-check`: `{ dateOfBirth: "YYYY-MM-DD" }` (never stored)
- `POST /api/auth/challenge`: `{ outpoint: { txid, vout }, path: ["receive", index] }`. Only receive-path coins sign in.
- `POST /api/auth/verify`: `{ signedTxHex, xpubReceive, xpubChange }`. The xpubs are kept only inside the encrypted session.
- `POST /api/auth/logout`: `{}`
- `POST /api/watches`: `{ loanId, rules? }`
- `PATCH /api/watches/:id`: `{ rules }`
- `POST /api/invoices`: `{ asset: "BCH", inputs: Outpoint[] }` (1 to 10 inputs)
- `POST /api/invoices/:id/submit`: `{ signedTxHex }`

## Pro pass payment

A 30-day Pro pass costs 0.25 USD, paid once in BCH on mainnet. It never renews.

**On the screen** (docs/COMPLIANCE.md): beside the pay button, show the terms from the invoice or
the quote, for example "Pro pass: 0.25 USD, paid once in BCH (about 0.00131 BCH at today's price).
Lasts 30 days. Does not renew. You are not charged again. Nothing to cancel." Every `Invoice`
carries them as `terms: { priceUsd: 0.25, days: 30, renews: false }`. After payment, show the
terms again as the receipt; the server also sends the receipt to the linked Telegram chat.

**In the browser**, `payProPass` from `@redline/wizard-login/client` does the whole flow:

```ts
import { payProPass, PaymentError } from "@redline/wizard-login/client";

const invoice = await payProPass({
  manager: conn.manager,            // the WizardConnect connection from sign-in
  onStep: (step, detail) => setStep(step), // quote, coins, invoice, signing, submitting, checking
}); // resolves with the paid Invoice
```

- It keeps the pending invoice id in `localStorage["redline-pending-invoice"]`. A reload or retry
  continues that invoice with the same coins, so a second payment is a double spend the network
  refuses. If the server finds the payment already on chain, the step `checking` says
  "Already paid".
- `PaymentError.code`: `no_paths`, `no_funds` (says how many sats and names receive address 0,
  also in `address`), `wallet_rejected` (the wallet's own message; the invoice is kept, never
  retry with other coins), `server_rejected` (`serverCode`, `status` from the API),
  `already_paid` (show "Already paid" and refresh `/me`), `network`.

**The routes**, all needing a session (401) and limited to 5 requests a minute per account (429):

- `GET /api/invoices/quote` → `InvoiceQuote`: `amountSats = ceil(0.25 / priceUsd x 1e8)` at the
  current on-chain price, valid 5 minutes. 503 `not_ready` before chain data, or while the price
  is outside 10 to 100,000 USD per BCH (a broken feed sells nothing).
- `POST /api/invoices` → 201 `Invoice`. The amount is fixed by the server. Every input is read
  from the chain: it must exist, carry no tokens, be unspent and sit on receive or change address
  0 to 19 of the signed-in wallet. Invoices expire after 30 minutes. Errors (400 unless noted):
  `bad_request`, `duplicate_input`, `input_not_found`, `foreign_input`, `token_input`,
  `input_spent`, `insufficient_inputs`; 409 `already_paid` (an earlier invoice turned out to be
  paid; Pro is on); 409 `invoice_open` (another invoice is still payable; `error.invoiceId`
  names it, pay that one); 503 `chain_unavailable` when an earlier payment cannot be checked (it
  fails closed rather than risk charging twice).
- `POST /api/invoices/:id/submit { signedTxHex }` → the paid `Invoice`. The transaction must
  spend exactly the invoice's inputs, pay at least `amountSats` to `merchantAddress`, carry the
  invoice's OP_RETURN once, and no tokens. The server broadcasts it, confirms the network knows
  it, and only then marks the invoice paid and extends Pro by 30 days (stacking on a running
  pass). A second submit returns the same invoice. Errors: 400 `bad_tx`, `wrong_inputs`,
  `underpaid`, `wrong_op_return`, `token_output`; 409 `inputs_spent`; 502 `broadcast_failed`.
- `GET /api/invoices/:id` → `Invoice`. While unpaid, if its coins were spent the server looks
  for the payment on chain and marks it paid when found. Otherwise it carries `inputsSpent: true`:
  start a new invoice.

`Invoice.opReturnHex` is the OP_RETURN payload after the `0x6a` opcode: a push of "PWINV" and a
push of the 16 id bytes. `encodeInvoiceOpReturn(id)` from `@redline/wizard-login` builds it.

**Accepted risks.** Paid means the network has the transaction, not that it is confirmed: a payer
could try to double-spend after Pro starts (a race for 0.25 USD). The server trusts the public
Fulcrum servers it reads from. Coin ownership uses the change xpub as sent at sign-in, which
sign-in does not prove; at worst a user locks their own coins into their own invoice.

## Error codes

All errors use the envelope above. Every code below is returned by the real server today.

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
| 503 | `telegram_unavailable` | the server has no Telegram bot configured |
| 503 | `payments_unavailable` | the server has no `MERCHANT_ADDRESS` |
| 400, 409, 502 | payment codes | listed under "Pro pass payment" above |

## Planned contract changes (not yet in `api-types`)

None outstanding: every agreed change is in `api-types` and on the real server.

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
