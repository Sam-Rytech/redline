# Deploying Redline

Server on **Railway** (always-on, with a volume for SQLite), front end on **Vercel**. Until `apps/web` lands, the login demo (`apps/login-demo`) is the staging front end.

Do not use a host that sleeps on idle (Render free, etc.): the server polls the chain and sends Telegram alerts, so it must run 24/7.

## 1. Railway: the server

1. railway.com, New Project, Deploy from GitHub repo, pick this repo. Railway reads `railway.json` (Dockerfile build from `apps/server/Dockerfile`, health check `/api/health`, restart on failure).
2. In the service: Settings, Volumes (or right-click the service, Attach Volume), mount path `/data`. Without it the database is wiped on every deploy.
3. Variables tab, add:

| Name | Value | Why |
|---|---|---|
| `DB_PATH` | `/data/redline.db` | SQLite lives on the volume |
| `COOKIE_SECURE` | `true` | production cookies are Secure |
| `LOGIN_DOMAIN` | `localhost` for now (step 3 sets the real host) | domain bound into the sign-in transaction |
| `PUBLIC_ORIGIN` | leave unset for now (step 3) | CSRF origin check, Telegram link base |
| `TRUST_PROXY_HOPS` | `0` for now (step 4) | how many proxies sit in front of the server |
| `MERCHANT_ADDRESS` | your CashTokens address, `bitcoincash:z...` | where Pro payments go (receive-only); unset = payments off |
| `TELEGRAM_BOT_TOKEN`, `BOT_USERNAME` | set in step 5 | bot and alerts |

Do not set `PORT`; Railway provides it. All variables are documented in `apps/server/.env.example`.
4. Settings, Networking, Generate Domain. Check Settings, Deploy: restart policy is "On failure" and the service is not set to sleep/serverless.

## 2. Check the server

```bash
curl https://<railway-domain>/api/health
curl -s https://<railway-domain>/api/loans | head -c 400
```

Health answers `{"ok":true,...}`. `blockHeight` is `null` until the first chain refresh finishes (under a minute).

## 3. Vercel: the web app

1. Edit `apps/login-demo/vercel.json`: replace `REPLACE-WITH-RAILWAY-DOMAIN` with the Railway domain (no `https://`, no trailing slash). Commit and push.
2. vercel.com, Add New Project, import the repo. **Root Directory: `apps/login-demo`** (later `apps/web`). Keep "Include source files outside of the Root Directory" enabled (the default), since the build installs the whole workspace. The install and build commands come from `vercel.json`. Deploy.
3. Note the Vercel domain, e.g. `redline-demo.vercel.app`. In Railway Variables set:
   - `PUBLIC_ORIGIN=https://<vercel domain>`
   - `LOGIN_DOMAIN=<vercel domain without https://>`
   Railway redeploys. (If you later add a custom domain, change both.)

## 4. Proxy hops (rate limiting by real client IP)

The Vercel rewrite and Railway each add to `x-forwarded-for`. Measure instead of guessing:

1. Railway: add `LOG_XFF=1` (redeploys).
2. On the Vercel site, make one sign-in attempt (press Connect, scan, let it request a challenge; failure is fine).
3. Railway, Deployments, View Logs: look for `x-forwarded-for (1/5): a, b, c`.
4. Find your real public IP (what you see at ifconfig.me). Count its position **from the right**, starting at 1. If the log is `1.2.3.4, 76.76.x.x` and your IP is `1.2.3.4`, it is second from the right, so `TRUST_PROXY_HOPS=2`. If your IP is the last entry, use 1.
5. Set `TRUST_PROXY_HOPS` to that number and delete `LOG_XFF`.

Never set a hop count higher than the real number of proxies: clients could then spoof their IP.

## 5. Telegram bot

1. In Telegram, open @BotFather, `/newbot`, pick a name and username.
2. Railway Variables: `TELEGRAM_BOT_TOKEN=<token>`, `BOT_USERNAME=<username without @>`.
3. **Only one running server may use a token** (Telegram long polling allows one poller). Keep the token out of your local `.env`, or stop the local dev server before testing against the deployed bot.

## 6. Smoke checklist

- [ ] `/api/loans` lists about 140 active loans
- [ ] Sign in on phone and on laptop with the same wallet gives the same account (G3)
- [ ] Connect Telegram, then `/status` in the bot answers
- [ ] A low-threshold alert fires on a real loan (G4)
- [ ] Pro payment activates the pass (G5)

## 7. For jadonamite (`apps/web`)

- Add the same `vercel.json` to `apps/web` (change nothing but keep the `/api/:path*` rewrite and the Railway domain; the install and build commands use the workspace filter name, so set it to `@redline/web`).
- Call the API with **relative** URLs (`/api/...`) and `credentials: "include"` on every fetch. The rewrite makes the API same-origin, which the session cookie and CSRF check need. Do not call the Railway domain directly.
- Then change the Vercel project's Root Directory to `apps/web`.
