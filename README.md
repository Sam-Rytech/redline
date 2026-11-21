# Redline

Know before your loan hits the red.

Redline watches ParyonUSD loans on Bitcoin Cash. If a loan's collateral ratio falls below 110%,
the protocol closes it and the borrower loses the collateral, with no warning. Redline reads every
loan from the chain, shows how close each one is to that line, and sends a Telegram message before
a watched loan gets there. It also shows loans whose debt was paid off by redemptions but which
still hold BCH their owners have not claimed.

Independent project, not affiliated with ParyonUSD. Built for BCH BLAZE 2026; started 17 Nov 2026,
no pre-hackathon code. Live site: `<link>`.

## What it does

- **Every loan, live.** Collateral ratio, liquidation price, distance to liquidation, place in the
  redemption queue and pending rate changes, read from mainnet about every minute. No wallet
  needed to browse.
- **Unclaimed collateral.** Loans with no debt left but BCH still locked, with a link to claim it
  in the Paryon app.
- **Wallet sign-in.** Paytaca or Selene over WizardConnect. No password and no email: the wallet
  signs a small self-payment that is not sent.
- **Telegram alerts.** One message when a watched loan crosses 25%, 15% or 8% from liquidation,
  and one if it closes. `/status`, `/mute`, `/unmute` and `/help` in the chat.
- **Pro pass.** 0.25 USD, paid once in BCH, for 30 days of unlimited watches. It does not renew.

## How it works

The server reads Paryon's contracts directly over Electrum (Fulcrum):

- every loan sits at one contract address, and its state is a 27-byte commitment on its NFT;
- the next output of each loan transaction (the sidecar) carries the loan's token id, which links
  the loan to the loan key in the owner's wallet;
- the BCH price comes from the protocol's price contract.

Decoded totals match stats.paryonusd.com. A read that is partial, empty or from a lagging server is
discarded, so a network glitch cannot look like a loan disappearing.

Sign-in: the browser builds a transaction that spends one of the wallet's own coins back to itself
and carries a one-time nonce from the server in an OP_RETURN. The wallet signs it without sending
it. The server checks the signature against the coin it reads from the chain, the nonce, the
domain, and that the request came from the same browser. The sign-in code is a reusable package,
`packages/wizard-login`, for any WizardConnect app.

Details: `ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/API.md`.

## Run it

Requires Node 22.12 or newer and pnpm 11.

```bash
pnpm install
pnpm test
```

```bash
pnpm dev:mock      # mock API with sample loans, http://localhost:8787/api
pnpm dev:server    # real API on mainnet, same port (stop the mock first)
pnpm dev:login     # wallet sign-in and Pro pass test page, http://localhost:5174
```

For the test page, start the server with `PUBLIC_ORIGIN=http://localhost:5174`.

## Configuration

The server reads only environment variables; `apps/server/.env.example` lists each one with a
safe default. Production needs `NODE_ENV=production`, `SESSION_SECRET` and `PUBLIC_ORIGIN`;
Telegram needs `TELEGRAM_BOT_TOKEN` and payments need `MERCHANT_ADDRESS`. Deploying:
`docs/DEPLOY.md`.

## Layout

```
apps/server         API, chain reader, alert engine, Telegram bot, SQLite (node:sqlite)
apps/mock-api       mock of the API for front-end work
apps/login-demo     page for testing sign-in and payment with a real wallet
apps/web            the web app
packages/api-types  the API contract shared by front and back end
packages/paryon-decoder  reads and decodes ParyonUSD state from the chain
packages/wizard-login    WizardConnect sign-in and payment, browser and server halves
docs/               product, security, database, API, design, brand and compliance docs
```

## License

MIT, see `LICENSE`.
