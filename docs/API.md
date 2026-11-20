# Redline API (for the front end)

Types: `packages/api-types/src/index.ts` — import with `import type { … } from "@redline/api-types"`.
All routes are under `/api`. Always call relative URLs (`fetch("/api/loans", { credentials: "include" })`).

## Run the mock

```bash
pnpm install
pnpm dev:mock          # http://localhost:8787/api
```

Vite proxy (`apps/web/vite.config.ts`, once the web app exists):
```ts
server: { proxy: { "/api": "http://localhost:8787" } }
```
Production: Vercel rewrites `/api/:path*` to the Railway server, so cookies stay same-origin.

## Endpoints

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
| GET/POST | /api/watches | ✓ | `Watch[]` / `Watch` (201) — 403 `watch_limit` on free plan |
| PATCH/DELETE | /api/watches/:id | ✓ | `Watch` / `{ ok: true }` |
| POST | /api/telegram/link-token | ✓ | `TelegramLinkResponse` |
| POST | /api/invoices | ✓ | `Invoice` (201) |
| GET | /api/invoices/:id | ✓ | `Invoice` |
| POST | /api/invoices/:id/submit | ✓ | `Invoice` |

Errors are always `{ "error": { "code": "...", "message": "..." } }` (401 `unauthorized`, 403 `watch_limit`, 404 `not_found`, 400 `bad_request`).

## Mock-only behaviour

- `POST /api/auth/verify` with any `{ "signedTxHex": "00" }` signs you in — no wallet needed.
- `GET /api/me/loans` returns 3 loans: critical, watch, stranded.
- Submitting an invoice marks it paid and turns on Pro (watch limit becomes unlimited).
- `GET /api/mock/telegram-linked` marks Telegram as connected (requires sign-in, like other non-public routes).
- State resets when the mock restarts.

## Real sign-in (later)

The Sign in screen will call `wizardLogin({ manager, apiBase: "/api", domain })` from `packages/wizard-login` (not created yet); it returns a `MeResponse`. Until then, use the mock shortcut above.
