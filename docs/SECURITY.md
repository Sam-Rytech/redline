# Redline security

Scope: what the server and the web app must do to keep people's wallets, accounts and data
safe. Not legal advice; privacy and age items are flagged for a lawyer in `COMPLIANCE.md`.

## What we protect

| Asset | Why it matters |
|---|---|
| Wallet public keys (xpubs) | They reveal every address and the full history of a wallet |
| Sessions | A stolen session is a stolen account |
| Telegram chat ids | Personal data; also the delivery path for alerts |
| The merchant address and invoice records | Money; a bug here can double-charge or give away Pro |
| Alert integrity | A false or missing alert can cost someone their collateral |

There are no private keys, no custody and no funds on the server. The merchant address is
receive-only.

## Sign-in protocol and its threats

The wallet signs a transaction that is not meant to be sent. Full steps in `ARCHITECTURE.md`
section 3.1. Threats and decisions:

1. **Relay attack (decision: bind the challenge to the browser).** An attacker's page can ask
   our server for a challenge and show it to a victim's wallet. If the session went to
   whoever submitted the signed result, the attacker would be signed in as the victim. Fix:
   `POST /auth/challenge` sets an HttpOnly cookie `rl_ch` (path `/api/auth`, 5 minutes)
   holding a random 32-byte id; the challenge row stores its sha256. `POST /auth/verify` must
   carry the same cookie, or it is rejected with `challenge_mismatch`, and every verify attempt
   clears it. The wallet prompt also names our domain, and the OP_RETURN carries it.
2. **Replay.** Nonce is 16 random bytes, single use, 5 minute expiry, bound to `LOGIN_DOMAIN`.
3. **The signed transaction is broadcastable.** Harmless by design: it pays the user's own
   address back to itself minus about 300 satoshis. The server never logs or stores the signed
   hex, and drops it after verification.
4. **Never trust client-supplied outputs.** The server fetches the source output from the chain
   itself and checks the address, the signature (libauth VM) and that the outpoint is unspent
   or spent by this exact transaction.
5. **Wallets that broadcast anyway.** Verification accepts it; the interface says "this wallet
   sends a tiny self-payment to sign in".
6. **Signing in as someone else's account (found in review, 20 Nov).** The account id is
   `sha256(xpubReceive)`, so the login must prove that exact key: only a receive-path coin can
   sign in (`bad_path` otherwise), and the server derives the address from the receive xpub the
   browser sends at verify. An attacker who knows a victim's xpub cannot sign for the victim's
   address. The change xpub is not proven; it is only used to look for loan keys.
7. **Signatures that do not cover the whole transaction (found in review).** The input must be
   exactly `<signature> <public key>`, the signature type must be SIGHASH_ALL|FORKID (0x41), and
   the public key must be the derived one. A SIGHASH_NONE or ANYONECANPAY signature, which would
   not commit to the nonce, is rejected.
8. **Token coins.** A coin carrying CashTokens (possibly a loan key) is refused as the sign-in
   coin, because a broadcast login transaction would burn the token. The coin must hold at
   least 2,000 satoshis.

## Data minimisation (decision)

The wallet's xpubs are needed once, at sign-in, and to find which loan keys are in the wallet.
They are not needed for alerts.

- The `accounts` table stores only `id = sha256(xpubReceive)`, plus plan and age fields. No xpub.
- The xpubs live only inside the session row, encrypted with AES-256-GCM under a key derived
  from `SESSION_SECRET` (HKDF), bound to that session's id so a row cannot be moved to another
  session, and are deleted when the session ends or expires. The browser sends them with
  `/auth/verify`; the challenge row never holds them.
- Logs never contain xpubs, signed transaction hex, session ids, cookies or Telegram tokens.
- Signing in reveals one UTXO and the xpubs to our server. The privacy page says so.

## Sessions and cookies

- Cookie `rl_session`: HttpOnly, Secure, SameSite=Lax, path `/`, 7 days, a fresh random
  32-byte value on every sign-in. The `sessions` row is keyed by its sha256, so a database
  leak cannot be replayed as a cookie.
- Cookie `rl_age`: HttpOnly, Secure, SameSite=Lax, path `/`, holds the age result signed with
  an HMAC key derived from `SESSION_SECRET`, so the browser cannot forge "ok". A blocked
  result lasts a year; an ok result a day.
- Web and API share one origin: Vercel rewrites `/api/*` to the server, so the cookie is
  first-party and no CORS is needed. The server therefore sends no CORS headers. If a
  different origin is ever needed, it is added explicitly with credentials and a fixed
  allow-list, never `*`.
- **CSRF (forged requests from another site):** every state-changing request must be
  `application/json` and must carry an `Origin` that equals `PUBLIC_ORIGIN`, otherwise 403.
- Logout deletes the session row.

## Telegram

- Link tokens are single use, 10 minutes, random 128 bits, stored hashed.
- A chat id is linked to one account only; relinking requires the new account's token.
- The bot token is an environment secret and is never logged.
- `/mute` is honoured immediately and per account.

## Payments

- The invoice amount is computed on the server from the oracle price. The client cannot
  choose it.
- A retry must reuse the invoice's stored inputs, so a second payment is a double spend the
  network rejects. Before retrying, the server checks whether those inputs are spent.
- Pro is activated only after the server fetches the transaction itself and checks amount,
  recipient and invoice id in the OP_RETURN. A txid is unique to an invoice (database
  constraint), so one payment cannot activate two invoices.
- Pro status extends on the existing `pro_until`; two payments add 30 days each.

## Data integrity of the alarm

A smoke alarm that cries wolf is ignored. Requirements, also in the PRD:

- A refresh that returns fewer than 80% of the previous loans is discarded.
- A loan is "gone" only after 3 consecutive successful reads without it. Loans with a
  missing sidecar are counted and reported in `/api/health`, never silently dropped.
- `/api/loans` includes `stale: true` when data is older than 5 minutes, and alerts are not
  sent from stale data.
- Alert sends are idempotent: a unique key of watch, rule and band prevents duplicates after
  a restart.

## Abuse and availability

- Rate limits: `/api/auth/*` and `/api/age-check` 10 per minute per IP; `/api/utxos` 30 per minute per IP and a
  maximum of 40 addresses per call; invoices 5 per minute per account.
- Request bodies capped at 16 KB. All inputs validated against the types in `api-types`.
- The client IP for rate limits is the TCP peer, or, behind proxies, the entry
  `TRUST_PROXY_HOPS` positions from the right of `x-forwarded-for` (entries further left are
  written by the client and ignored). Check the real chain once on staging with `LOG_XFF=1`.
- Errors never include stack traces or internals. The envelope is `{ error: { code, message } }`.
- The server runs on an always-on host with a persistent volume. A sleeping host stops alerts.

## Supply chain and secrets

- Exact version pins for `@wizardconnect/*`, `cashscript`, `@bitauth/libauth` and every
  dependency; lockfile committed.
- Secrets only in host environment variables. `.env` files are git-ignored; `.env.example`
  lists every variable the code reads and nothing else.
- Variables: `ELECTRUM_HOST`, `TELEGRAM_BOT_TOKEN`, `SESSION_SECRET`, `PUBLIC_ORIGIN`,
  `LOGIN_DOMAIN`, `MERCHANT_ADDRESS`, `DATABASE_PATH`, `BACKUP_DIR`, `TRUST_PROXY_HOPS`,
  `LOG_XFF`. Read today: all except `TELEGRAM_BOT_TOKEN` and `MERCHANT_ADDRESS`, which arrive
  with the code that reads them. `SESSION_SECRET` (at least 32 characters) and `PUBLIC_ORIGIN`
  are required in production. `apps/server/.env.example` lists exactly the ones read.

## Privacy and deletion

`DELETE /api/me` removes the account, its sessions, watches, alert history and Telegram link
in one transaction. Alert history older than 90 days is purged. The privacy page lists what is
stored and for how long.

## Security checklist before launch

- [ ] Challenge binding test: verify from a different browser fails.
- [ ] Replay and expiry tests for the nonce.
- [ ] Logs inspected for xpubs, signed hex and cookies: none.
- [ ] Rate limits exercised.
- [ ] CSRF: a cross-origin POST is rejected.
- [ ] Double payment test with the same inputs.
- [ ] Partial-read test: alert engine sends nothing.
- [ ] Dependency versions pinned and audited.
