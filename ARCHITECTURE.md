# Redline — Architecture

> **Redline** — "Know before your loan hits the red." Independent project, not affiliated with ParyonUSD; say so in the site footer.

**Hackathon:** BCH BLAZE 2026 — Mainnet track
**Deadline:** Sun 22 Nov 2026, 14:00 UTC (15:00 Lagos). Internal freeze: Sun 11:00 Lagos.
**One-liner:** A smoke alarm for ParyonUSD loans. Sign in with your BCH wallet (no password), see your loans' risk, get Telegram alerts before you lose money.

Items marked **⚠ VERIFY** are not yet confirmed and each has a gate in `PROGRESS.md`. Do not build on top of them until the gate passes.

---

## 1. Why this exists (evidence)

| Problem | Source |
|---|---|
| Liquidation below 110% CR takes *all* collateral: "no appeal, no grace period, and no way to recover the BCH afterwards" | paryonusd.com/docs/user-guides/borrowing |
| Docs list things borrowers must "monitor themselves" (CR, interest erosion, redemption exposure, pending rate changes, loan-key authenticity) and mention no alerts | same page |
| "There is no automatic payout of leftover collateral after a full redemption" | paryonusd.com/docs/user-guides/redeeming |
| Redemptions hit lowest-rate loans first; docs tell borrowers to watch how many low-rate loans sit ahead of them, but offer no tool for it | same page |
| WizardConnect "covers transaction signing only" — no message signing, so WizardConnect apps have no wallet login | cashscript.org/docs/guides/walletconnect |
| 160 active loans, ~3,124 BCH (~$657k) collateral; dozens at ~126–133% CR | stats.paryonusd.com/loans (17 Nov 2026) |

What already exists (don't rebuild it): **stats.paryonusd.com** shows every loan's rate, debt, collateral, CR, liquidation price and a rate depth chart. We add what it lacks: **identity (which loans are mine), alerts, stranded-collateral detection, redemption-queue position for *my* loan**.

---

## 2. System overview

```
 ┌──────────────── Browser (apps/web, React) ────────────────┐
 │  Landing ─ Sign in (QR) ─ My loans / Watch any loan ─ Alerts│
 │  uses: packages/wizard-login (client)  @wizardconnect/dapp │
 └───────────────┬───────────────────────────────┬────────────┘
     WizardConnect│(Nostr relays, encrypted)      │HTTPS (JSON API)
                  ▼                               ▼
        ┌──────────────────┐        ┌─────────────────────────────────┐
        │  User's wallet   │        │  apps/server (Node, always-on)  │
        │ Paytaca / Selene │        │  ├─ API (auth, loans, watches,  │
        └──────────────────┘        │  │   invoices)                  │
                                    │  ├─ Chain reader (per block)    │
                                    │  ├─ Alert engine                │
                                    │  ├─ Telegram bot (grammY)       │
                                    │  └─ SQLite                      │
                                    └───────┬──────────────┬──────────┘
                                            │Electrum (WSS) │Bot API
                                            ▼              ▼
                                   Fulcrum server      Telegram
                                   (BCH mainnet)
```

Repo (pnpm workspaces):
```
/apps/web               React + Vite front end
/apps/server            API + chain reader + alert engine + Telegram bot
/packages/wizard-login  Reusable WizardConnect sign-in (client + server halves)
/packages/paryon-decoder Pure functions: decode loan/price state, compute risk
```

---

## 3. Components

### 3.1 `packages/wizard-login` — sign-in for WizardConnect apps

**Problem:** WizardConnect only signs transactions. We prove wallet control with a *signed but never broadcast* transaction that is harmless if it ever is broadcast.

**Protocol (v1)**

1. Client connects via WizardConnect → receives xpubs (`receive`, `change`; `defi` = index 7 if present).
2. Client derives **receive** addresses (indices 0–19), asks the server for UTXOs, picks the **smallest pure-BCH (token-free) UTXO ≥ 2,000 sats** on the receive path. Sign-in must prove control of the receive xpub, because `accountId` is derived from it; change-path UTXOs are refused (`bad_path`).
3. `POST /auth/challenge {xpubReceive, xpubChange, outpoint, path:["receive", index]}` (mainnet xpubs, receive ≠ change) → server stores `{nonce (16 random bytes), expiry = now+300s, domain, outpoint, sha256(binding token)}`, returns `{nonce, expiry, domain}` and sets the binding token as cookie `rl_chal` (HttpOnly, SameSite=Lax, Path=/api/auth, Max-Age=300, Secure). This binds the challenge to the requesting browser, so a login tx that leaks (e.g. a wallet broadcasts it and a mempool watcher copies it) cannot be redeemed by anyone else.
4. Client builds the login transaction (`buildUnsignedLoginTx`, libauth):
   - Input 0: the chosen UTXO
   - Output 0: `OP_RETURN` → `"WZL1"` | domain (utf-8) | nonce (16 B) | expiry (uint32 LE)
   - Output 1: P2PKH back to **the same address**, value = input − fee (client uses 400 sats; server accepts 200–2,000)
   - version 2, locktime 0, sequence 0xffffffff, no tokens anywhere; the signature must be **SIGHASH_ALL|FORKID (0x41)** so it commits to the nonce output
5. Client calls `signTransaction({ transaction, sourceOutputs, broadcast: false, userPrompt: "Sign in to Redline — this will NOT be sent" }, inputPaths=[[0, "receive", index]])`.
6. `POST /auth/verify {signedTxHex}` (with the `rl_chal` cookie). Server checks, in order:
   1. Decodes tx; exactly 1 input = challenge outpoint; outputs, version, locktime, sequence match the template above.
   2. OP_RETURN domain == our domain, nonce known, the browser's `rl_chal` hashes to the stored binding (`challenge_not_bound`), not expired, nonce unused.
   3. **Fetches the source output itself from Electrum** (never trusts client `sourceOutputs`); it must carry no tokens (`token_source`) and hold ≥ 2,000 sats.
   4. Address of that output == P2PKH derived from **`xpubReceive`** at the stated index; output 1 pays back to it; fee 200–2,000.
   5. Unlocking bytecode is exactly `<sig> <pubkey>` with the derived pubkey and a Schnorr or DER signature ending in 0x41; then the libauth VM `verify` of the full transaction against the fetched source output passes.
   6. Outpoint is unspent **or** spent by exactly this txid (covers wallets that broadcast anyway).
7. Server marks nonce used, sets `accountId = sha256(xpubReceive)`, issues an HttpOnly session cookie (7 days).

**Properties:** no password/email; replay-proof (single-use nonce + expiry); bound to our domain and to the requesting browser; worst case if broadcast = the user loses ~300 sats of fee, coins return to them.

**Fallback mode** (if a wallet ignores `broadcast:false`): same flow, the tx is simply on-chain; check 6 still passes. Show "this wallet sends a tiny self-payment to sign in".

**Public API (for other BLAZE teams):**
```ts
// client (@redline/wizard-login/client): domain comes from the server's challenge
const conn = connectWallet();  await conn.ready;   // QR: conn.qrUri
const me = await wizardLogin({ manager: conn.manager, apiBase: "/api" });
// server (framework-agnostic)
createChallenge(input) -> Challenge
verifyLogin(signedTxHex, deps: { getSourceOutput, isUnspentOrSpentBy, store }) -> { accountId }
```

### 3.2 `packages/paryon-decoder` — on-chain state → numbers

**Deployment (mainnet-v1)** — copy exact values from `github.com/ParyonUSD/verify_contract_deployment/config.ts` (don't retype hex):
- `paryonTokenId` (category on loan state NFTs and PUSD), `loanKeyFactoryTokenId`, `redeemerTokenId`, `poolTokenId`
- `startBlockHeight = 948406`, `periodLengthBlocks = 144`
- Oracle pubkey = General Protocols oracle (oracles.cash)

**Finding all loans**
- `Loan.cash` has an **empty constructor** → every loan uses identical bytecode → one P2SH address. Compute it from `@paryonusd/contracts@1.1.0` artifact (`paryonArtifacts`) with CashScript `Contract` (no args, P2SH32). ✅ Verified: `bitcoincash:pv8zrfxplp50apvppy5ku5mjp3gqgkp94dvwf82lg0st4ptk5agfyrtpjvf8a` (194 loan UTXOs on 20 Nov 2026).
- Fulcrum `blockchain.address.listunspent` (with token data) on that address → all loan UTXOs (~160).
- Keep UTXOs whose token `category == paryonTokenId`, NFT capability `mutable`, commitment length **27**, first byte `0x01`.

**Loan commitment (27 bytes)** — from `contract_docs/contract_overview.md`; offsets derived:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | identifier `0x01` |
| 1 | 6 | borrowedTokenAmount (current debt) |
| 7 | 6 | amountBeingRedeemed |
| 13 | 1 | status (`0x00` new, `0x01` single period, `0x02` mature) |
| 14 | 4 | lastPeriodInterestPaid |
| 18 | 2 | currentInterestRate |
| 20 | 2 | nextInterestRate |
| 22 | 1 | interestManager (`0x00` = none) |
| 23 | 2 | minRateManager |
| 25 | 2 | maxRateManager |

✅ Verified (G2, 20 Nov 2026 — totals and 6 loans match stats.paryonusd.com): fields are **little-endian**; PUSD has **2 decimals**; **collateral = the loan UTXO's satoshi value** (the liquidate contract uses `tx.inputs[1].value`); interest rates are **per 10,000,000 per period** (period = 144 blocks ≈ 1 day), so annual % = `raw × 365 / 100000` (max raw 32767 ⇒ 119.6 %).

**Loan ↔ loan key**
- The loan's sidecar is the next output of the same tx (`vout+1`); it holds an immutable NFT whose **category = loanTokenId**. ✅ Verified: sidecars sit at the LoanSidecar contract address (`bitcoincash:pdugdfdd9p84460sntu8rhmj75g8k7uaee699wzj5489l3n99h7s7f49drdgu`), so one `listunspent` on it maps every loan — no per-loan tx fetch.
- The user's **loan key** = a *minting* NFT of category `loanTokenId` in their wallet.

**Price**
- Primary: on-chain price contract UTXO (commitment `0x00 | sequence (4) | pricedata (4)`). Note the migration `PriceContract` → `PriceContractGuarded`. ✅ Verified: current price UTXO is at the **PriceContractGuarded** address (`bitcoincash:pdws0e456rwhzuxahv5jduryn493prvjrmu6ksegq052m5g048jp2tl4l6chh`); price is **US cents per BCH**, little-endian (e.g. `0x4a54` = 19028 = $190.28). The old PriceContract address is empty.
- Fallback: General Protocols oracle via oracles.cash (same oracle the contracts trust).

**Metrics (pure functions)**
- `collateralBCH = sats / 1e8`; `debt = borrowedTokenAmount / 10^decimals`
- `CR = collateralBCH × price / debt`; `liqPrice = debt / collateralBCH × 1.1`
- `distanceToLiq = (price − liqPrice) / price`
- `debtAhead = Σ debt of active loans with currentInterestRate < mine` (+ all loans with debt < 100 PUSD, which are redeemable regardless of rate)
- `redemptionInProgress = amountBeingRedeemed > 0`
- `pendingRateChange = nextInterestRate ≠ currentInterestRate`
- `stranded = debt == 0 && sats > dust` ✅ Verified: 54–55 debt-0 loans still sit at the loan address holding ~353 BCH (20 Nov 2026).

### 3.3 `apps/server`

**Chain reader** — subscribes to block headers on Fulcrum; on each new block (~10 min): refresh all loan UTXOs + price → in-memory snapshot + `loan_snapshots` row. Also a 60 s safety poll.

**Alert engine** — after each refresh, evaluate every watch:

| Rule | Default trigger |
|---|---|
| Liquidation distance | crosses 25% → 15% → 8% bands (alert once per band, re-arm when it recovers +3%) |
| Redemption queue | debtAhead < user threshold (default 20,000 PUSD) |
| Redemption started | `amountBeingRedeemed` goes from 0 to >0 |
| Rate change pending | `nextInterestRate` changed |
| Stranded collateral | debt reaches 0 with leftover BCH |
| Loan gone | UTXO disappears with no successor (liquidated/closed) |

Each alert deep-links to the official Paryon dApp to act. No in-app loan actions in v1.

**Telegram bot (grammY, long polling)** — linking: web shows "Connect Telegram" → `t.me/<bot>?start=<one-time token>` → bot stores `chat_id` against the account. Commands: `/status`, `/mute`, `/help`.

**API**
```
POST /auth/challenge      POST /auth/verify      POST /auth/logout
GET  /me                  GET  /utxos?addresses=…  (proxy, rate-limited)
GET  /loans               GET  /loans/:id         (public snapshot)
GET  /me/loans            (loans whose key is in the user's wallet)
POST /watches             DELETE /watches/:id    PATCH /watches/:id (thresholds)
POST /telegram/link-token
POST /invoices            GET /invoices/:id      POST /invoices/:id/submit {signedTxHex}
```

**Subscription (the mainnet transaction)**
- Plan: **30-day Pro pass** (one-time payment, no auto-renew) = 0.25 PUSD **or** equivalent BCH (BCH first, so judges without PUSD can pay).
- `POST /invoices` → `{id, amount, merchantAddress, opReturn: "PWINV"|id}`; server **persists the chosen inputs** with the invoice.
- Client builds: user inputs → merchant output + OP_RETURN invoice id + change; `signTransaction({broadcast: true})`.
- Server confirms by fetching the tx (mempool is fine), checking amount/recipient/invoice id, then activates Pro.
- Exactly-once: a retry **reuses the same inputs**, so a second payment is a double-spend the network rejects; before retrying, check whether those inputs are already spent and show "Already paid ✓ txid…".
- PUSD payment (stretch, same day if time): token input + BCH fee input; token output to merchant's token-aware `bitcoincash:z…` address; token change back.

**Free vs Pro:** Free = sign in, see your loans, 1 watch, liquidation alerts only. Pro (30-day pass) = unlimited watches + all rules.

### 3.4 `apps/web`

Screens:
1. **Landing** — big text: "Your PUSD loan can be liquidated with no warning. We warn you first." Live counter: "N loans are within 20% of liquidation right now." Buttons: *Sign in with wallet* / *Watch any loan*.
2. **Sign in** — QR + explainer of the "sign, not sent" prompt.
3. **My loans** — cards: CR, distance to liquidation (gauge), debt ahead in queue, pending rate, stranded BCH, "Open in Paryon" link.
4. **Watch any loan** — searchable table of all loans (lets judges with no loan try the product).
5. **Alerts** — Telegram connect, thresholds, Pro upgrade (pay).
6. Persistent **BLAZE banner** at top (see §8).

---

## 4. Data model (SQLite)

```
accounts(id TEXT PK /*sha256(xpubReceive)*/, xpub_receive, xpub_change, created_at, pro_until)
challenges(nonce PK, account_hint, outpoint, path, domain, expiry, used_at)
sessions(id PK, account_id, expires_at)
telegram_links(token PK, account_id, chat_id, created_at, used_at)
watches(id PK, account_id, loan_token_id, rules_json, last_band, created_at)
alerts_sent(id PK, watch_id, rule, value, sent_at)
invoices(id PK, account_id, asset, amount, inputs_json, txid, status, created_at, paid_at)
loan_snapshots(block_height, loan_token_id, debt, collateral_sats, rate, next_rate, redeeming, status, PRIMARY KEY(block_height, loan_token_id))
```

---

## 5. Stack and pinned versions

| Piece | Choice | Pin / note |
|---|---|---|
| Runtime | Node.js 20 LTS + TypeScript | |
| Package manager | pnpm workspaces | |
| Wallet connection | `@wizardconnect/dapp` + `@wizardconnect/core` | **Pin both to the same exact version** (0.2.7 at time of writing). `dapp` declares `core: "*"`, and 5 releases shipped 12–13 Nov — unpinned installs can break overnight |
| Tx building | `cashscript` | Pin one exact version. Use `generateWcTransactionObject()` and attach `inputPaths` yourself (official docs); a preview doc mentions `generateWizardConnectTransactionObject()` — don't rely on it |
| BCH primitives / VM verify | `@bitauth/libauth` v3 | |
| Electrum | `@electrum-cash/network` → public Fulcrum (WSS) | ✅ Fulcrum 2.1.4 returns token data in `listunspent`. Hosts used (with fallback): bch.imaginary.cash, electrum.imaginary.cash, bch.loping.net, fulcrum.greyh.at, electroncash.dk |
| Paryon artifacts | `@paryonusd/contracts@1.1.0` | Loan address + contract shapes |
| Server | Hono (or Express) + `better-sqlite3` | |
| Bot | `grammy` | Long polling, no webhook needed |
| Front end | Vite + React + Tailwind | |
| Hosting | Web: Vercel. Server: Railway (or any always-on VM) + persistent volume | Free tiers that sleep (Render free) **stop alerts** — don't use them |

Env vars: `ELECTRUM_URL`, `TELEGRAM_BOT_TOKEN`, `SESSION_SECRET`, `PUBLIC_ORIGIN`, `LOGIN_DOMAIN`, `MERCHANT_ADDRESS` (token-aware `z…`), `PRICE_SOURCE`.

---

## 6. Security

- Server fetches every source output itself; never trusts client-supplied UTXO data.
- Sign-in proves the **receive** xpub only (account id = sha256(xpubReceive)); a login never rewrites an account's receive xpub.
- Nonces: 16 random bytes, single-use, 5-minute expiry, bound to `LOGIN_DOMAIN` and to the requesting browser (`rl_chal` HttpOnly cookie; only its hash is stored).
- Login signatures must be SIGHASH_ALL|FORKID; NONE/SINGLE/ANYONECANPAY are refused (they would not commit to the nonce). The source UTXO must be token-free.
- Session cookie: HttpOnly, Secure (default; `COOKIE_SECURE=false` only for plain-http non-localhost testing), SameSite=Lax; new random session per login, stored hashed.
- CSRF: every POST must be `Content-Type: application/json` (415 otherwise); with `PUBLIC_ORIGIN` set, `Origin` must match (403). POST bodies capped at 32 KB (413).
- Telegram link tokens: single-use, 10-minute expiry.
- Rate-limit `/auth/*` and the UTXO proxy (30/min per IP). Client IP = socket address, or with `TRUST_PROXY_HOPS=N` the Nth `x-forwarded-for` entry from the right (1 = the one the nearest proxy appended; Vercel rewrite -> Railway needs the real chain checked on staging with `LOG_XFF=1` first). Legacy `TRUST_PROXY=true` = 1 hop.
- Electrum calls time out after 15 s and the connection is closed.
- Keep xpubs server-side only; never show them in the UI or logs. Privacy note in docs: signing in reveals one UTXO and the wallet's xpubs to the server.
- No private keys anywhere on the server. The merchant address is receive-only.
- Pro pass payments, accepted risks: Pro is granted on mempool acceptance (0-conf; a payer could double spend $0.25 after the fact); the server trusts its Electrum hosts for spent state, mempool and merchant history (raw txs are hash-checked, absence is not); invoice inputs must sit on the account's receive or change xpub, and the change xpub is trust-on-first-use (sign-in proves only the receive xpub). Server never trusts client amounts or UTXO data; exactly-once via pinned inputs + one DB transaction (paid + Pro extension).

---

## 7. Gotchas (each costs a day if found late)

1. `@wizardconnect/dapp` depends on `@wizardconnect/core@*` → pin both exactly.
2. WizardConnect `inputPaths` indices refer to the **final** input order — build them after the tx is finalised.
3. WizardConnect helpers return `undefined` on error in the docs' examples — always surface the real error.
4. Keepalive: ~75 s without pong/`wallet_ready` → `reconnecting`. A `wallet_ready` that arrives before pairing is dropped — the wallet must resend.
5. Transport is **not exactly-once**: reconnects can redeliver; a dapp reload mid-send loses in-flight state. Hence persisted invoices + reused inputs.
6. `destroy()` rejects pending sign requests with unknown outcome — "do not retry with another wallet blindly".
7. Selene scans ~20 addresses ahead; don't derive far-out indices and expect the wallet to see them.
8. Paytaca doesn't show unconfirmed txs — tell testers "it may take ~10 min to appear in Paytaca".
9. Banner + prizes need a **CashTokens** (`bitcoincash:z…`) address.
10. Electrum can't search by token category → duplicate-loan-key detection needs Chaingraph (stretch; ⚠ VERIFY a public endpoint).
11. Price contract was migrated (`PriceContract` → `PriceContractGuarded`); don't hard-code the old address.
12. DoraHacks: new accounts (< 7 days) can create max 3 BUIDLs — create the BUIDL early.

---

## 8. BLAZE submission requirements mapped

| Requirement | How we meet it |
|---|---|
| Judges can make a useful mainnet tx | Pro subscription payment (0.25 PUSD or BCH equivalent) |
| WizardConnect or XO | WizardConnect for sign-in and payment |
| Live demo, one click | `https://<app>` with "Watch any loan" so judges without a loan can try it |
| Banner: Widget Factory slides, repo, CashTokens address | Persistent top banner on every page |
| Pre-existing work | None — banner states "Started 17 Nov 2026, no pre-hackathon code" |
| Telegram check-in + roll call | Done (verify roll-call timestamp < 14 Nov 19:25) |

---

## 9. Out of scope (v1)

- Acting on loans in-app (add collateral, change rate, withdraw) → deep links to the Paryon dApp. Stretch only if everything else is done.
- Stability-pool / staking monitoring.
- Email/SMS alerts.
- Duplicate-loan-key check (needs Chaingraph) → stretch.
