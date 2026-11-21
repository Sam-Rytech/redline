# Deploying Redline

The server runs on Railway (always on, with a persistent volume). The web app runs on Vercel and
forwards `/api/*` to the server, so the browser sees one origin and cookies stay first-party
(`SECURITY.md`). Until `apps/web` lands on `main`, `apps/login-demo` can stand in on Vercel.

## 1. Server on Railway

1. New project → Deploy from GitHub repo → this repo. Railway reads `railway.json` and builds
   `apps/server/Dockerfile` from the repo root.
2. Add a volume mounted at `/data`. The server must not sleep: a sleeping server sends no alerts.
3. Set these variables (exactly the ones `apps/server/.env.example` lists):

   | Variable | Value | Why |
   |---|---|---|
   | `NODE_ENV` | `production` | turns on the strict checks |
   | `SESSION_SECRET` | 64 random hex characters (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) | encrypts session keys and signs the age cookie; changing it signs everyone out |
   | `DATABASE_PATH` | `/data/redline.db` | the SQLite file on the volume |
   | `BACKUP_DIR` | `/data/backups` (better: a second volume) | nightly backups, 7 kept |
   | `PUBLIC_ORIGIN` | `https://<your-vercel-domain>` | the only Origin allowed on POST, PATCH, DELETE |
   | `LOGIN_DOMAIN` | `<your-vercel-domain>` (host only) | the domain the wallet signs into the login transaction |
   | `TRUST_PROXY_HOPS` | `0` for now; see step 4 | how to find the client IP for rate limits |
   | `TELEGRAM_BOT_TOKEN` | from @BotFather (`/newbot`) | Telegram linking and alerts |
   | `MERCHANT_ADDRESS` | your `bitcoincash:z...` address | where Pro pass payments go |
   | `ELECTRUM_HOST` | leave empty | five public Fulcrum servers are tried in turn |

   `PORT` is set by Railway.
4. Deploy, then open `https://<railway-domain>/api/health`: `ok: true` with a `blockHeight`
   within a minute.

## 2. Web on Vercel

1. New project → import this repo → Root Directory `apps/web` (or `apps/login-demo` until the
   web app is on `main`).
2. In that folder's `vercel.json`, replace `REPLACE-WITH-RAILWAY-DOMAIN` in the `/api/:path*`
   rewrite with the Railway domain, commit, deploy. `apps/web` needs the same rewrite.
3. Put the Vercel domain into the Railway variables `PUBLIC_ORIGIN` and `LOGIN_DOMAIN` and redeploy
   the server.

## 3. Telegram

One running server per bot token: leave `TELEGRAM_BOT_TOKEN` empty on your own machine while the
hosted server uses it, or the two fight over updates.

## 4. Find the proxy hop count

The rate limits need the visitor's real IP, which arrives in `x-forwarded-for` behind Vercel and
Railway.

1. Set `LOG_XFF=1` and redeploy.
2. From the Vercel site, start one sign-in.
3. In the Railway logs, read the `x-forwarded-for (1/5): ...` line. Find your own public IP in it
   and count its position from the right: right-most is 1. Set `TRUST_PROXY_HOPS` to that number.
4. Remove `LOG_XFF` and redeploy.

## 5. Checks after deploy

- `/api/loans` shows about 140 active loans, `stale: false` (PRD R1, R3).
- Sign in with the same wallet on a laptop and a phone: the same account id (R5, gate G3).
- Connect Telegram, then `/status` in the chat answers.
- Watch a loan; a real alert reaches the chat when it crosses a band (gate G4).
- Someone outside the team buys the Pro pass; `/api/me` shows `pro: true` and the receipt
  arrives in their chat (R7, gate G5).
- The `SECURITY.md` checklist before launch.
