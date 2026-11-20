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
Serves live ParyonUSD loans from BCH mainnet, refreshed every 60 s (after a failed refresh it retries once after 10 s). Real routes so far: `GET /api/health`, `GET /api/loans`, `GET /api/loans/:id`, `POST /api/auth/challenge`, `POST /api/auth/verify`, `POST /api/auth/logout`, `GET /api/me`, `GET /api/me/loans`, `GET /api/utxos`, `GET/POST /api/watches`, `PATCH/DELETE /api/watches/:id`, `POST /api/telegram/link-token`, `POST /api/telegram/unlink`, `GET /api/invoices/quote`, `POST /api/invoices`, `GET /api/invoices/:id`, `POST /api/invoices/:id/submit`. Every other `/api/*` path returns 404 `not_found`.

Env: `LOGIN_DOMAIN` (default `localhost`; must match what the client puts in the login tx), `DB_PATH` (default `./data/redline.db`), `COOKIE_SECURE` (cookies are `Secure` by default, which works on `http://localhost`; set `false` only for plain-http testing on another host), `TRUST_PROXY_HOPS` (integer >= 0, default 0 = rate limit by socket address; N = the Nth `x-forwarded-for` entry from the right, 1 = right-most; fewer entries than N falls back to the left-most; legacy `TRUST_PROXY=true` means 1; an invalid value fails at start). Behind Vercel rewrite -> Railway, set `TRUST_PROXY_HOPS` after checking the real header chain on staging (log it once with `LOG_XFF=1`, which logs the raw `x-forwarded-for` of the first 5 `/api/auth` requests, never more), `PUBLIC_ORIGIN` (e.g. `https://redline.app`; when set, every POST, PATCH and DELETE must send that exact `Origin`; the bot's `/start` intro also links to it), `ELECTRUM_HOST` (tried first; then the built-in public Fulcrum list `bch.imaginary.cash`, `electrum.imaginary.cash`, `bch.loping.net`, `fulcrum.greyh.at`, `electroncash.dk` on connection failure), `TELEGRAM_BOT_TOKEN` (turns on the Telegram bot and alerts; without it `POST /api/telegram/link-token` returns 503 `telegram_unavailable`; get one by messaging [@BotFather](https://t.me/BotFather) `/newbot`), `BOT_USERNAME` (the bot's username without `@`, used in the `t.me` link; if unset the server asks Telegram via `getMe` at start), `MERCHANT_ADDRESS` (where Pro pass payments go: a mainnet `bitcoincash:` address, token-aware `z…` preferred, `q…`/`p…` also accepted; receive-only, the server never has its key; an invalid value fails at start; unset → every invoice route answers 503 `payments_unavailable`). Node prints a one-line SQLite `ExperimentalWarning` at start; harmless.

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

### Watches and Telegram alerts (real server)

All need a session (401 `unauthorized`). PATCH must send `Content-Type: application/json` like POST.

- `GET /api/watches` → `Watch[]` (yours, oldest first). `lastBand` is the band at the last alert check (`null` before the first check, and after the loan is gone).
- `POST /api/watches { loanId, rules? }` → 201 `Watch`. 400 `bad_request` (missing/invalid `loanId`, non-boolean rules), 503 `not_ready` before chain data, 404 `not_found` if the loan is not in the current data, 409 `watch_exists`, 403 `watch_limit` (free plan = 1 watch; Pro = unlimited while `pro_until` is in the future). `rules` defaults to `{ liquidation: true, loanGone: true }`; partial rules are merged.
- `PATCH /api/watches/:id { rules }` → `Watch` (partial merge; `{}` is a no-op that returns the watch unchanged, on the mock too). `DELETE /api/watches/:id` → `{ ok: true }`. Someone else's watch → 404 `not_found`.
- `POST /api/telegram/link-token {}` → `TelegramLinkResponse { token, url: "https://t.me/<bot>?start=<token>", expiresAt }`. Open `url`; the token is single use and valid 10 minutes (only its hash is stored). 503 `telegram_unavailable` when no bot is configured.
- `POST /api/telegram/unlink {}` → `{ ok: true }`; `GET /api/me` `telegramLinked` reflects the link.

Bot commands (private chat only): `/start <token>` links the chat (one chat per account), `/status` lists your watches (CR, distance, liquidation price, band, or "loan closed"), `/mute` (24 h; `/mute 2h`, `/mute 30m`, max 7 days), `/unmute`, `/help`.

Alerts (checked after every successful refresh): **liquidation bands** — alert once when a loan enters a worse band (watch < 25 %, danger < 15 %, critical < 8 % from liquidation); the band is only re-armed after recovering 3 points past its threshold (e.g. danger → watch needs ≥ 18 %). A new watch is recorded silently unless it is already danger or critical. **Loan gone** — alert once when a loan that was already checked is missing from two refreshes in a row (closed, repaid or liquidated); a restart never fires it on its first snapshot. Muted or unlinked accounts get no message, but the band still advances (no burst later). At most 20 messages per refresh, most severe first; the rest go out next refresh. A failed send is retried next refresh; if Telegram answers 403 (bot blocked or removed) the chat is unlinked.

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

### Pro pass payments (real server)

30-day Pro pass = $0.25 in BCH, one-time, mainnet. All routes need a session (401) and `MERCHANT_ADDRESS` (else 503 `payments_unavailable`); they share the 30/min/IP rate limit with `/api/auth/*` and `/api/utxos`. 503 `chain_unavailable` whenever Electrum cannot be reached. The browser helper `payProPass` (below) does all of this.

- `GET /api/invoices/quote` → `InvoiceQuote`: `amountSats = ceil(0.25 / priceUsd × 1e8)` at the chain reader's current price, `validUntil` = now + 5 min. 503 `not_ready` before the first chain refresh, and while the price is outside 10–100,000 USD/BCH (a broken feed sells nothing; same for `POST /api/invoices`).
- `POST /api/invoices { asset: "BCH", inputs: Outpoint[] }` → 201 `Invoice`. The amount is fixed now from the current price (never from the client). The server first reads each input's raw transaction from Electrum (exists, on receive/change address 0–19 of the signed-in wallet, no tokens) and only then asks which of those scripts' coins are unspent. Errors (400 unless noted): `bad_request` (asset not BCH, 0 or > 10 inputs, malformed outpoint), `duplicate_input`, `input_not_found`, `foreign_input`, `token_input`, `input_spent`, `insufficient_inputs` (total < amountSats + `estimatePaymentFee(inputs)`, the same 1 sat/byte estimate the client uses: 300 for one input), 409 `already_paid` (an earlier unpaid invoice of this account from the last 24 h turns out to be paid on chain: it is marked paid and Pro is on; message "Already paid ✓" with the txid, `error.invoiceId`), 409 `invoice_open` (another unexpired invoice with different coins is still payable — its coins are all unspent; `error.invoiceId` names it: pay that one), 503 `not_ready`. Invoices expire after 30 min. The same inputs (any order) as the open invoice return it (200). An open invoice whose coins were spent elsewhere, or that has expired, is replaced. If checking an earlier invoice hits an Electrum outage, the purchase carries on.
- `Invoice.opReturnHex` = the OP_RETURN payload after the `0x6a` opcode: push `"PWINV"` + push of the 16 id bytes (`05 5057494e56 10 <id>`); the output's locking bytecode is `6a` + that. `encodeInvoiceOpReturn(id)` (from `@redline/wizard-login`) builds it.
- The payment tx: exactly the invoice's inputs (any order), one output paying ≥ `amountSats` to `merchantAddress`, exactly one OP_RETURN output (the invoice's), no token outputs; change is free-form.
- `POST /api/invoices/:id/submit { signedTxHex }` → `Invoice` (`paid`). Someone else's or an unknown invoice → 404 `not_found`; already paid → the invoice unchanged (idempotent; Pro is never extended twice). Checks in order (400): `bad_request` (not hex), `bad_tx`, `wrong_inputs`, `underpaid`, `wrong_op_return`, `token_output`. Then the server broadcasts it itself. Accepted, or "already known" (the wallet broadcast it first, the usual case) → the server looks the tx up (up to 3 times, 1 s apart) → paid; if the lookups miss but the node's broadcast answer was exactly our txid, it is paid too. Inputs already spent → it looks for the paying tx in the merchant address's recent history (50 newest, mempool first; it must spend one of the invoice's inputs, have exactly one OP_RETURN = the invoice's, and pay ≥ the amount): found → paid with that txid; else 409 `inputs_spent`. Any other rejection → 502 `broadcast_failed` with the node's reason. An expired invoice is still accepted (its coins are pinned, so it is still one payment).
- `GET /api/invoices/:id` → `Invoice`; while unpaid, if any of its inputs is spent the server runs the same history search (the merchant history is cached 20 s across requests) and marks it paid when found (covers a submit that never arrived). If not found, the invoice carries `inputsSpent: true`: it can never be paid, start a new one. Once such an invoice is 10 min past its expiry it is given up for good (shown as `expired` with `inputsSpent: true`, never rescanned). An Electrum outage does not fail GET: it answers with what it knows.
- Paid → `pro_until = max(now, pro_until) + 30 days` (stacks on a running pass), in the same DB transaction that marks the invoice paid; `GET /api/me` shows `pro: true`, `watchLimit: null`.

**Accepted risks (hackathon scope).** Paid = the transaction is known to the network (mempool), not confirmed: a 0-conf double spend by the payer after Pro is granted is possible (it costs them a race for $0.25). The server trusts the public Electrum (Fulcrum) hosts it talks to for transactions, spent state and history (raw transactions are hash-checked against their txid, but a lying host could hide a spend or a payment). Input ownership uses the change xpub as sent at sign-in (trust on first use: sign-in proves only the receive xpub); at worst a user locks their own other coins into their own invoice.

### Demo page (real wallets)

```bash
pnpm dev:server        # real server on :8787
pnpm dev:login         # http://localhost:5174 (proxies /api to :8787)
```
Open http://localhost:5174, click **Connect wallet**, scan with Paytaca or Selene, then **Sign in**. The page logs every step with timestamps, shows the `MeResponse`, the login txid and a Blockchair link to check whether the wallet broadcast it (it should not). Buttons: GET /me, Log out, Disconnect wallet. The wallet needs a plain coin of ≥ 2,000 sats on one of its first 20 receive addresses. After sign-in the page shows the Pro pass quote (sats, price, merchant address) and **Buy 30-day Pro (≈ $0.25 in BCH)**, which runs `payProPass` with a step log, then shows the txid, a Blockchair link and `/me` (needs `MERCHANT_ADDRESS` on the server; this is a real mainnet payment).

## Pro pass (front end)

```ts
import { payProPass, PaymentError } from "@redline/wizard-login/client";

const invoice = await payProPass({
  manager, // the connected wallet (same as wizardLogin)
  onStep: (step, detail) => log(step, detail), // "quote" | "coins" | "invoice" | "signing" | "submitting" | "checking"
  // optional: apiBase = "/api", fetch, signal, storage = localStorage
}); // resolves with the paid Invoice
```
- Keeps the pending invoice id in `localStorage["redline-pending-invoice"]`. Every call first `GET`s that invoice: `paid` → returns it at once, with step `checking` and detail "Already paid ✓ txid …" (show that); `open` → reuses the invoice's pinned inputs (never picks new coins); `open` with `inputsSpent`, expired or unknown → starts fresh.
- New purchase: quote → `GET /api/utxos` for receive + change 0–19 → token-free coins, largest first, until ≥ amountSats + fee (≈ 1 sat/byte, min 300, ≤ 10 inputs; the server's bar) → `POST /api/invoices` (on 409 `invoice_open` it reuses that open invoice and its coins). Before asking the wallet it refuses (`server_rejected`) an invoice costing more than the quote + 5 % or paying an address other than the quote's. Tx: inputs in the invoice's order; outputs merchant, OP_RETURN, change to change address 0 (dropped into the fee below 546 sats); `signTransaction({ broadcast: true, userPrompt: "Pay 30-day Redline Pro pass" })` with `inputPaths` built from the final input order.
- If the submit's connection fails it asks `GET /api/invoices/:id` (the server finds a payment the wallet already broadcast) → paid; otherwise `network`. Retrying is safe: it reuses the same coins, so a second payment is a double spend the network refuses.
- `PaymentError.code`: `no_paths`, `no_funds` (message says how many sats and names receive address 0, also in `address`), `wallet_rejected` (the wallet's own message; the invoice is kept: never retry with other coins blindly), `server_rejected` (`serverCode`, `status` from the API), `already_paid` (the server found an earlier payment: show "Already paid ✓" and refresh `/me`), `network`.

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
| POST | /api/telegram/unlink | ✓ | `{ ok: true }` |
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
- `POST /api/invoices`: `{ asset: "BCH", inputs: Outpoint[] }` (1–10 inputs)
- `POST /api/invoices/:id/submit`: `{ signedTxHex }`

## Pro pass payment flow

1. `GET /api/invoices/quote` for `amountSats` and the merchant address.
2. Pick inputs worth at least `amountSats` + `estimatePaymentFee(inputs)` (≈ 1 sat/byte, min 300).
3. `POST /api/invoices` with those inputs.
4. Sign with `broadcast: true`.
5. `POST /api/invoices/:id/submit` with the signed tx.

Use `payProPass` (above): it stores the invoice id in localStorage so a reload can `GET /api/invoices/:id` and show "Already paid ✓", and reuses the pinned inputs on retry.

## Mock-only behaviour

- `POST /api/auth/verify` with any `{ "signedTxHex": "00" }` signs you in — no wallet needed.
- `GET /api/me/loans` returns 3 loans: critical, watch, stranded.
- Submitting an invoice marks it paid and turns on Pro (watch limit becomes unlimited).
- `GET /api/mock/telegram-linked` marks Telegram as connected (requires sign-in, like other non-public routes).
- State resets when the mock restarts.
