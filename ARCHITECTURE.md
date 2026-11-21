# Redline — Architecture

> **Redline** — "Know before your loan hits the red." Independent project, not affiliated with ParyonUSD; say so in the site footer.

**Hackathon:** BCH BLAZE 2026 — Mainnet track
**Deadline:** Sun 22 Nov 2026, 14:00 UTC (15:00 Lagos). Internal freeze: Sun 11:00 Lagos.
**One-liner:** A smoke alarm for ParyonUSD loans. Sign in with your BCH wallet (no password), see your loans' risk, get Telegram alerts before you lose money.

Related documents (all in `docs/`): `PRD.md` (what and why), `SECURITY.md`, `DATABASE.md`, `API.md`, `DESIGN.md`, `BRAND.md`, `COMPLIANCE.md`, `PRACTICES.md`. Where `SECURITY.md` or `DATABASE.md` differ from this file, they win; the differences are listed in `DATABASE.md`.

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
2. Client derives receive/change addresses (indices 0–19 each), asks the server for UTXOs, picks the **smallest pure-BCH UTXO ≥ 2,000 sats** (no tokens).
3. `POST /auth/challenge {xpubReceive, outpoint, path:[pathName, index]}` → server stores `{nonce (16 random bytes), expiry = now+300s, domain, outpoint, browser_id}`, sets an HttpOnly `rl_ch` cookie holding `browser_id`, and returns the nonce, expiry and domain. `/auth/verify` must carry the same cookie, so a challenge answered from another browser is rejected (relay attack, see `SECURITY.md`).
4. Client builds the login transaction (CashScript `TransactionBuilder`, placeholder P2PKH unlocker):
   - Input 0: the chosen UTXO
   - Output 0: `OP_RETURN` → `"WZL1"` | domain (utf-8) | nonce (16 B) | expiry (uint32 LE)
   - Output 1: P2PKH back to **the same address**, value = input − fee (fee ≈ 1 sat/byte, ~250–300 sats)
5. Client calls `signTransaction({ transaction, sourceOutputs, broadcast: false, userPrompt: "Sign in to Redline — this will NOT be sent" }, inputPaths=[[0, pathName, index]])`.
6. `POST /auth/verify {signedTxHex}`. Server checks, in order:
   1. Decodes tx; exactly 1 input = challenge outpoint; outputs match the template above.
   2. OP_RETURN domain == our domain, nonce == stored nonce, not expired, nonce unused.
   3. **Fetches the source output itself from Electrum** (never trusts client `sourceOutputs`).
   4. Address of that output == address derived from `xpubReceive`/`change` at the stated path.
   5. libauth VM `verify` of the full transaction against the fetched source output passes (proves the signature).
   6. Outpoint is unspent **or** spent by exactly this txid (covers wallets that broadcast anyway).
7. Server marks nonce used, sets `accountId = sha256(xpubReceive)`, issues an HttpOnly session cookie (7 days).

**Properties:** no password/email; replay-proof (single-use nonce + expiry); bound to our domain; worst case if broadcast = the user loses ~300 sats of fee, coins return to them.

**Fallback mode** (if a wallet ignores `broadcast:false`): same flow, the tx is simply on-chain; check 6 still passes. Show "this wallet sends a tiny self-payment to sign in".

**Public API (for other BLAZE teams):**
```ts
// client
const session = await wizardLogin({ manager /* DappConnectionManager */, apiBase, domain });
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
- `Loan.cash` has an **empty constructor** → every loan uses identical bytecode → one P2SH address. Compute it from `@paryonusd/contracts@1.1.0` artifact (`paryonArtifacts`) with CashScript `Contract` (no args, P2SH32). Verified: `bitcoincash:pv8zrfxplp50apvppy5ku5mjp3gqgkp94dvwf82lg0st4ptk5agfyrtpjvf8a` (194 loan outputs on 21 Nov 2026).
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

Verified (gate G2; totals and individual loans match stats.paryonusd.com on 20 and 21 Nov 2026): fields are **little-endian**; PUSD has **2 decimals**; **collateral = the loan UTXO's satoshi value** (the liquidate contract reads `tx.inputs[1].value`); interest rates are **per 10,000,000 per period** (one period = 144 blocks, about a day), so the annual percentage is `raw × 365 / 100000`, and the maximum raw value 32767 gives 119.6 %.

**Loan ↔ loan key**
- The loan's sidecar is the next output of the same tx (`vout+1`); it holds an immutable NFT whose **category = loanTokenId**. Verified: sidecars sit at the LoanSidecar contract address (`bitcoincash:pdugdfdd9p84460sntu8rhmj75g8k7uaee699wzj5489l3n99h7s7f49drdgu`), so one `listunspent` there maps every loan without fetching each transaction.
- The user's **loan key** = a *minting* NFT of category `loanTokenId` in their wallet.

**Price**
- Primary: on-chain price contract UTXO (commitment `0x00 | sequence (4) | pricedata (4)`). Note the migration `PriceContract` → `PriceContractGuarded`. Verified: the live price output is at the **PriceContractGuarded** address (`bitcoincash:pdws0e456rwhzuxahv5jduryn493prvjrmu6ksegq052m5g048jp2tl4l6chh`); the price is **US cents per BCH**, little-endian (`0x4a54` = 19028 = $190.28). The old PriceContract address is empty.
- Fallback: General Protocols oracle via oracles.cash (same oracle the contracts trust).

**Metrics (pure functions)**
- `collateralBCH = sats / 1e8`; `debt = borrowedTokenAmount / 10^decimals`
- `CR = collateralBCH × price / debt`; `liqPrice = debt / collateralBCH × 1.1`
- `distanceToLiq = (price − liqPrice) / price`
- `debtAhead = Σ debt of active loans with currentInterestRate < mine` (+ all loans with debt < 100 PUSD, which are redeemable regardless of rate). Rates are compared as the raw on-chain values; the rounded percentage is for display only.
- `redemptionInProgress = amountBeingRedeemed > 0`
- `pendingRateChange = nextInterestRate ≠ currentInterestRate` (raw values)
- `stranded = debt == 0 && sats > dust`. Verified: 53 debt-0 loans sit at the loan address holding 352.8 BCH (21 Nov 2026).

### 3.3 `apps/server`

**Chain reader** — subscribes to block headers on Fulcrum; on each new block (~10 min): refresh all loan UTXOs + price → in-memory snapshot + `loan_snapshots` row. Also a 60 s safety poll. Integrity rules: a refresh that returns fewer than 80% of the previous loans is discarded; a loan is "gone" only after 3 consecutive successful reads without it; loans with no sidecar are counted in `/api/health`, not dropped silently; stale data (older than 5 minutes) is flagged on `/api/loans` and never used to send alerts.

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

Superseded by `docs/DATABASE.md` (no xpubs in `accounts`, challenge browser binding, alert idempotency, age result). The sketch below is kept for history only.

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
| Electrum | `@electrum-cash/network` → public Fulcrum (WSS) | Verified: Fulcrum 2.1.4 returns token data in `listunspent` (bch.imaginary.cash, electrum.imaginary.cash, bch.loping.net, fulcrum.greyh.at, electroncash.dk all answer on wss port 50004) |
| Paryon artifacts | `@paryonusd/contracts@1.1.0` | Loan address + contract shapes |
| Server | Hono (or Express) + `better-sqlite3` | |
| Bot | `grammy` | Long polling, no webhook needed |
| Front end | Vite + React + Tailwind | |
| Hosting | Web: Vercel. Server: Railway (or any always-on VM) + persistent volume | Free tiers that sleep (Render free) **stop alerts** — don't use them |

Env vars: `ELECTRUM_HOST`, `TELEGRAM_BOT_TOKEN`, `SESSION_SECRET`, `PUBLIC_ORIGIN`, `LOGIN_DOMAIN`, `MERCHANT_ADDRESS` (token-aware `z…`), `DATABASE_PATH`. (`ELECTRUM_HOST` is what the code reads today; the price source is the on-chain oracle contract, so there is no `PRICE_SOURCE` setting.)

---

## 6. Security

- Server fetches every source output itself; never trusts client-supplied UTXO data.
- Nonces: 16 random bytes, single-use, 5-minute expiry, bound to `LOGIN_DOMAIN`.
- Session cookie: HttpOnly, Secure, SameSite=Lax; rotate on login.
- Telegram link tokens: single-use, 10-minute expiry.
- Rate-limit `/auth/*` and the UTXO proxy.
- Keep xpubs server-side only, only inside the encrypted session row, never in `accounts`, the UI or logs. Privacy note in docs: signing in reveals one UTXO and the wallet's xpubs to the server.
- Web and API share one origin through Vercel rewrites, so cookies are first-party and no CORS is needed. Full rules in `docs/SECURITY.md`.
- No private keys anywhere on the server. The merchant address is receive-only.

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
