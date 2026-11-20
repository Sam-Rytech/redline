# Redline

**A smoke alarm for ParyonUSD loans.** Sign in with your BCH wallet (no password), see how close each of your loans is to liquidation, and get a Telegram alert before you lose your collateral.

> Independent project, not affiliated with ParyonUSD. Built for BCH BLAZE 2026 (Mainnet track).

- **Live demo:** `https://REPLACE-WITH-LIVE-URL` (use "Watch any loan" if you have no loan)
- **Widget Factory slides:** `REPLACE-WITH-SLIDES-LINK`
- **CashTokens address (banner/prizes):** `bitcoincash:z...REPLACE`

## Why

- Liquidation below 110% collateral ratio takes *all* the collateral: "no appeal, no grace period" (ParyonUSD borrowing docs).
- The docs list what borrowers must "monitor themselves" (ratio, interest, redemption exposure, rate changes) and mention no alerts.
- On 17 Nov 2026: 160 active loans, about 3,124 BCH (~$657k) of collateral, dozens at roughly 126-133% CR.
- stats.paryonusd.com shows every loan, but not *which loans are yours*, and cannot warn you.

## Features

- Wallet sign-in with WizardConnect (Paytaca, Selene): no password, no email
- **My loans**: collateral ratio, distance to liquidation, redemption-queue position
- **Watch any loan**: no loan needed, so anyone can try it
- Telegram alerts on liquidation-distance bands and when a loan is gone; `/status`, `/mute`
- **Pro pass**: 30-day, one-time BCH payment, unlimited watches; exactly-once even if the wallet retries
- Free plan: 1 watch

## Architecture

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

Full design and security notes: [ARCHITECTURE.md](ARCHITECTURE.md). API reference: [docs/API.md](docs/API.md).

## Repo layout

```
apps/server              API, chain reader, alert engine, Telegram bot, SQLite
apps/web                 React front end
apps/login-demo          Minimal sign-in/payment test page (staging stand-in for the web app)
apps/mock-api            Mock server with fixtures, for front-end work
packages/wizard-login    Reusable WizardConnect sign-in (client + server halves)
packages/paryon-decoder  On-chain loan/price state to numbers and risk metrics
packages/api-types       Shared TypeScript types for every endpoint
```

## How loans are read from chain

- Every ParyonUSD loan uses the same contract bytecode (empty constructor), so all loans sit at **one P2SH address**, computed from `@paryonusd/contracts` artifacts. One Fulcrum `listunspent` call returns every loan.
- Each loan UTXO carries a mutable NFT whose **27-byte commitment** encodes: identifier, current debt, amount being redeemed, status, last interest period, current and next rate, and the rate-manager fields. Collateral is the UTXO's satoshi value.
- The loan's **sidecar** output (next output of the same transaction) holds an immutable NFT whose category is the loan id; the borrower's **loan key** is a minting NFT of that category, which is how "my loans" is found.
- Price comes from the on-chain price contract. Then `CR = collateral x price / debt` and liquidation price is `debt / collateral x 1.1`.

Decoded values are checked against stats.paryonusd.com (`pnpm --filter @redline/paryon-decoder verify:live`).

## Wallet sign-in over WizardConnect

WizardConnect only signs transactions, so Redline proves wallet control with a transaction that is **signed but not broadcast**:

- A self-spend of one small token-free coin on the wallet's **receive** path, with an `OP_RETURN` committing to a server nonce, the site domain and an expiry. If a wallet broadcasts it anyway, the user loses about 400 sats of fee and the coins return to the same address.
- The challenge is bound to the requesting browser by an HttpOnly cookie, so a leaked login transaction cannot be redeemed by anyone else.
- Signature must be **SIGHASH_ALL|FORKID** so it commits to the nonce output.
- The server fetches the spent output from Electrum itself, then runs the full libauth VM over the transaction. The account id is `sha256(receive xpub)`.

This is packaged as a reusable widget for other WizardConnect apps: [packages/wizard-login](packages/wizard-login/README.md).

## Payments

The Pro pass is one BCH payment (about 0.25 PUSD equivalent, quoted by the server) to a receive-only merchant address, built and signed in the wallet through WizardConnect. The server persists the chosen inputs with the invoice, so a retry reuses them and a second payment would be a double spend the network rejects. Confirmation and the Pro extension happen in one database transaction. Details and accepted risks: ARCHITECTURE.md sections 3.3 and 6.

## Local development

Requires Node 22.12+ and pnpm 11.

```bash
pnpm install
pnpm dev:mock      # mock API on :8787 (fixtures)
pnpm dev:server    # real server on :8787 (live mainnet data; stop the mock first)
pnpm dev:login     # sign-in demo on :5174, proxies /api to :8787
pnpm test          # all packages
pnpm typecheck
```

Server settings are documented in [apps/server/.env.example](apps/server/.env.example).

## Deploy

Server on Railway (Dockerfile + persistent volume), web on Vercel. Step by step: [docs/DEPLOY.md](docs/DEPLOY.md).

## BLAZE notes

- **Started 17 Nov 2026. No pre-hackathon code.**
- Independent project, not affiliated with ParyonUSD.
- Widget Factory slides: `REPLACE-WITH-SLIDES-LINK`
- CashTokens address: `bitcoincash:z...REPLACE`

## License

[MIT](LICENSE) (c) 2026 Redline contributors
