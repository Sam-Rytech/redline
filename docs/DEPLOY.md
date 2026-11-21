# Deploying Redline

The server runs on Fly.io (always on, with a persistent volume). The web app runs on Vercel and
forwards `/api/*` to the server, so the browser sees one origin and cookies stay first-party
(`SECURITY.md`). Until `apps/web` lands on `main`, `apps/login-demo` can stand in on Vercel.

Free hosts that sleep or have no lasting disk (Render free, for example) do not work: a sleeping
server sends no alerts, and a wiped disk loses sessions, watches and paid Pro passes.

## 1. Server on Fly.io

Install flyctl (Windows PowerShell: `iwr https://fly.io/install.ps1 -useb | iex`), then
`fly auth login`. Run everything below from the repo root; `fly.toml` there builds
`apps/server/Dockerfile` and already sets `NODE_ENV`, `PORT`, `DATABASE_PATH=/data/redline.db` and
`BACKUP_DIR=/data/backups`, keeps one machine running and checks `/api/health`.

1. `fly apps create redline-bch` (if the name is taken, pick another and change `app` in
   `fly.toml`).
2. `fly volumes create redline_data --region ams --size 1` (one volume: the server runs on one
   machine, since SQLite has one writer).
3. Set the secrets (the rest of `apps/server/.env.example`):

   | Secret | Value | Why |
   |---|---|---|
   | `SESSION_SECRET` | 64 random hex characters (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) | encrypts session keys and signs the age cookie; changing it signs everyone out |
   | `PUBLIC_ORIGIN` | `https://<your-vercel-domain>` | the only Origin allowed on POST, PATCH, DELETE |
   | `LOGIN_DOMAIN` | `<your-vercel-domain>` (host only) | the domain the wallet signs into the login transaction |
   | `TRUST_PROXY_HOPS` | `0` for now; see step 4 | how to find the client IP for rate limits |
   | `TELEGRAM_BOT_TOKEN` | from @BotFather (`/newbot`) | Telegram linking and alerts |
   | `MERCHANT_ADDRESS` | your `bitcoincash:z...` address | where Pro pass payments go |
   | `ELECTRUM_HOST` | leave unset | five public Fulcrum servers are tried in turn |

   `fly secrets set SESSION_SECRET=... PUBLIC_ORIGIN=... LOGIN_DOMAIN=... --stage` (`--stage`
   applies them on the next deploy). The server refuses to start in production without
   `SESSION_SECRET` and `PUBLIC_ORIGIN`. The Fly domain is fixed by step 1, so section 2 (Vercel)
   can run before this step and give you the Vercel domain.
4. `fly deploy --ha=false`, then open `https://redline-bch.fly.dev/api/health`: `ok: true` with a
   `blockHeight` within a minute. `fly logs` shows the server output.

## 2. Web on Vercel

1. New project → import this repo → Root Directory `apps/web` (or `apps/login-demo` until the
   web app is on `main`).
2. In that folder's `vercel.json`, replace `REPLACE-WITH-SERVER-DOMAIN` in the `/api/:path*`
   rewrite with the Fly domain (`redline-bch.fly.dev`), commit, deploy. `apps/web` needs the same rewrite.
3. Put the Vercel domain into the secrets `PUBLIC_ORIGIN` and `LOGIN_DOMAIN`
   (`fly secrets set ...` restarts the server with them).

## 3. Telegram

One running server per bot token: leave `TELEGRAM_BOT_TOKEN` empty on your own machine while the
hosted server uses it, or the two fight over updates.

## 4. Find the proxy hop count

The rate limits need the visitor's real IP, which arrives in `x-forwarded-for` behind Vercel and
Fly.

1. `fly secrets set LOG_XFF=1`.
2. From the Vercel site, start one sign-in.
3. In `fly logs`, read the `x-forwarded-for (1/5): ...` line. Find your own public IP in it
   and count its position from the right: right-most is 1. Set `TRUST_PROXY_HOPS` to that number.
4. `fly secrets set TRUST_PROXY_HOPS=<n>`, then `fly secrets unset LOG_XFF`.

## 5. Checks after deploy

- `/api/loans` shows about 140 active loans, `stale: false` (PRD R1, R3).
- Sign in with the same wallet on a laptop and a phone: the same account id (R5, gate G3).
- Connect Telegram, then `/status` in the chat answers.
- Watch a loan; a real alert reaches the chat when it crosses a band (gate G4).
- Someone outside the team buys the Pro pass; `/api/me` shows `pro: true` and the receipt
  arrives in their chat (R7, gate G5).
- The `SECURITY.md` checklist before launch.
