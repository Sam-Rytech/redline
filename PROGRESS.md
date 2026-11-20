# Redline — Progress & Plan

**Deadline:** Sun 22 Nov 2026, 15:00 Lagos (14:00 UTC). **Internal freeze: Sun 11:00 Lagos. Submit by 13:00.**
All times are Lagos (UTC+1). Update this file at the end of every work block.

Status legend: ⬜ not started · 🟨 in progress · ✅ done · ❌ failed/blocked

---

## Team & roles (re-planned Fri 20 Nov)

| Who | Owns | Code |
|---|---|---|
| **Sam** (+ Claude Code building) | Back end, wallet protocol, Paryon data, alerts, payments; accounts, real-wallet testing, deploy, submission | `apps/server`, `packages/wizard-login`, `packages/paryon-decoder`, `packages/api-types` |
| **Jadonamite** | Front end | `apps/web` |

**Contract between the two:** `packages/api-types` (shared TypeScript types for every endpoint) + a **mock server** (`pnpm dev:mock`) serving realistic fixtures. Jadonamite builds every screen against the mock; we switch `VITE_API_BASE` to the real server when it's ready. **Changing a type = tell the other side in the team chat.**

Sam-only tasks (need a human, accounts or a phone wallet): DoraHacks BUIDL, @BotFather token, funding Paytaca + Selene, Railway/Vercel accounts, wallet testing (G1/G3/G5), recruiting testers (G6), slides, submission.

---

## Scope cuts (we lost Tue–Thu)

- **Sign-in:** build verification so it accepts both outcomes (not broadcast, or broadcast-and-spent-by-this-tx). G1 becomes "which wallets broadcast" — informational, not blocking.
- **Alerts:** only **liquidation distance** (bands + hysteresis) and **loan gone** are required. Redemption-queue, redemption-started, rate-change, stranded → stretch.
- **Payment:** BCH only. PUSD payment → stretch.
- **Free vs Pro:** Free = 1 watch; Pro = unlimited watches. Rule gating is dropped.

---

## Hard gates (new deadlines)

| # | Gate | Owner | Deadline | Pass condition | If it fails | Status |
|---|---|---|---|---|---|---|
| G0 | Accounts & funds | Sam | Fri 16:00 | Repo ✅; jadonamite accepted invite; BUIDL draft on DoraHacks; Paytaca + Selene each ~$0.50 BCH; bot token | Ask in BLAZE Telegram for a few cents | 🟨 |
| G-API | Front end unblocked | Claude | Fri 17:00 | `api-types` + mock server on `main`; jadonamite can `pnpm dev` the web app against it | — | ✅ |
| G2 | Loan decode matches | Claude | Fri 23:00 | For 5 live loans, decoded debt, collateral BCH, rate, liq price equal stats.paryonusd.com | Fix units/endianness; Sat 10:00 ask in Paryon Telegram | ✅ |
| G1 | `broadcast:false` behaviour known | Sam | Sat 11:00 | Know for Paytaca and Selene whether the login tx is broadcast | Already covered by fallback — just document it | ⬜ |
| G3 | Sign-in works end to end | Sam + Claude | Sat 14:00 | Same wallet on laptop and phone → same account; reused/expired nonce rejected | Ship "Watch any loan" without sign-in; keep going | ⬜ |
| G4 | Real alert fired | Claude | Sat 16:00 | Telegram alert from real mainnet data (low test threshold on a real loan) | Liquidation-distance only, no hysteresis | ⬜ |
| G5 | Mainnet payment by an outsider | Sam | Sat 21:00 | Someone outside the team pays the Pro pass in BCH; Pro activates | Team-member payment + record it in the demo | ⬜ |
| G6 | Outside testers | Sam | Sat 22:00 | 3 BLAZE people: open site → sign in or watch a loan → connect Telegram, without help | Fix top 3 confusions Sun morning | ⬜ |
| G7 | Submission complete | Sam | Sun 13:00 | Every item in the Submission checklist ticked | — | ⬜ |

---

## Plan

### Fri 20 Nov — today
- [x] **Sam:** GitHub repo created (public), jadonamite invited
- [x] **Claude:** monorepo scaffold (pnpm workspaces, TS); `packages/api-types`; mock server with fixtures → **G-API by 17:00** (see `docs/API.md`)
- [ ] **Jadonamite:** accept invite; `apps/web` (Vite + React + Tailwind) against the mock; Landing + Watch any loan table
- [ ] **Sam:** DoraHacks BUIDL draft; @BotFather token; fund Paytaca + Selene; copy Widget Factory slides → **G0**
- [x] **Claude:** decoder — Loan address from `@paryonusd/contracts@1.1.0`, Fulcrum `listunspent`, decode commitment, price → **G2 by 23:00** (`pnpm --filter @redline/paryon-decoder verify:live`)
- [ ] **Sam:** create Railway + Vercel projects (connect the repo)

### Sat 21 Nov
- [ ] **Claude:** chain reader (per block) + real `/loans`; snapshot table
- [ ] **Claude:** `wizard-login` client + `/auth/challenge`, `/auth/verify`, sessions, `/me`, `/me/loans` (sidecar mapping)
- [ ] **Sam:** test login tx on Paytaca + Selene → **G1 by 11:00**, then **G3 by 14:00**
- [ ] **Jadonamite:** Sign in screen (QR + "signed, not sent" explainer), My loans cards, Alerts screen, banner, footer, mobile layout
- [ ] Deploy server (Railway) + web (Vercel) by 12:00 — even if ugly
- [ ] **Claude:** Telegram bot (`/start <token>`, `/status`, `/mute`) + liquidation-band alerts → **G4 by 16:00**
- [ ] **Claude:** BCH invoices (persisted inputs, retry reuses them, server confirms, Pro activates)
- [ ] 15:00 — final check-in stream (watch for last-minute rule notes)
- [ ] **Sam:** outsider pays → **G5 by 21:00**; 3 testers → **G6 by 22:00**
- [ ] Landing live counter ("N loans within 20% of liquidation")

### Sun 22 Nov — ship
- [ ] 09:00–11:00 only bug fixes. **11:00 freeze** — no new features
- [ ] README (setup, architecture, sign-in protocol)
- [ ] Record a 60–90 s demo video (optional but helps)
- [ ] Complete DoraHacks BUIDL; tick Submission checklist → **G7**
- [ ] **Submit by 13:00** (deadline 15:00)

---

## Submission checklist

- [ ] Live demo URL opens in one click and works on mobile
- [ ] A judge with no PUSD loan can still try it ("Watch any loan")
- [ ] A judge can make a mainnet tx (Pro payment in BCH)
- [ ] WizardConnect works with Paytaca and Selene
- [ ] Top banner on the home page has: Widget Factory slides link · GitHub repo link · CashTokens address (`bitcoincash:z…`) · "Started 17 Nov 2026 — no pre-hackathon code"
- [ ] Repo is public; README explains setup, architecture, and the sign-in protocol
- [ ] Footer: "Independent project, not affiliated with ParyonUSD"
- [ ] DoraHacks BUIDL submitted with demo, repo, slides links
- [ ] Telegram intro posted; roll-call timestamp confirmed before 14 Nov 19:25

---

## Stretch (only after G7 items are safe)

- [ ] Alert rules: redemption queue, redemption started, rate change pending, stranded collateral
- [ ] PUSD subscription payment
- [ ] Duplicate loan-key warning (needs a Chaingraph endpoint)
- [ ] Interest-erosion projection ("at this rate your liq price rises to $X in 30 days")
- [ ] In-app "add collateral" via Paryon artifacts

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Field units/endianness wrong | Medium | High | G2 tonight; compare with stats site |
| Collateral not equal to UTXO sats | Low | High | G2; fall back to sidecar/stats reading |
| Front end blocked on back end | Medium | High | api-types + mock server first (G-API) |
| API drift between web and server | Medium | Medium | One shared `api-types` package; announce changes |
| Wallets ignore `broadcast:false` | Medium | Low | Verification accepts broadcast-and-spent-by-this-tx |
| Price contract address unknown | Medium | Medium | oracles.cash fallback |
| WizardConnect package churn | Medium | Medium | Exact version pins, commit lockfile |
| Host sleeps, alerts stop | Medium | High | Always-on host (Railway/VM) |
| Only ~45 h of build time | High | High | Scope cuts above; freeze Sun 11:00 |

---

## Decision log

| Date | Decision | Why |
|---|---|---|
| 17 Nov | Build the PUSD loan-alert app (now Redline) with WizardConnect login as its sign-in (one submission) | Documented gaps in both ParyonUSD and WizardConnect docs; outside the crowded payments field; strongest "will it make money" |
| 17 Nov | No in-app loan actions in v1 | Paryon contracts are complex (26 contracts, sidecars); deep-link instead |
| 17 Nov | BCH payment before PUSD payment | Judges may not hold PUSD |
| 20 Nov | Renamed to **Redline** | Avoids looking like an official Paryon product; "Canary" and "Watchtower" already taken in BTC/BCH |
| 20 Nov | Payment is a one-time **30-day Pro pass**, not a recurring charge | It is the required mainnet tx and the "will it make money" proof; no auto-renew to build |
| 20 Nov | Roles: Jadonamite = front end; Sam + Claude Code = everything else | Front end can run in parallel against a mock API |
| 20 Nov | Scope cut to liquidation + loan-gone alerts, BCH-only payment; sign-in accepts broadcast or not | Nothing built by Fri; ~45 h left |

---

## Daily log

**Tue 17 Nov** — Idea chosen, architecture written.

**Wed 18 Nov** — (no build work)

**Thu 19 Nov** — (no build work)

**Fri 20 Nov** — Renamed to Redline; payment labelled "30-day Pro pass". Public repo created, jadonamite invited. Roles re-split and plan re-scoped. G-API done: api-types, risk metrics, mock API (`pnpm dev:mock`), docs/API.md merged to main. Added `GET /api/invoices/quote` (price before choosing inputs); duplicate watch → 409. TODO: verify `PARYON_APP_URL`. G2 done: live decode matches stats.paryonusd.com (140 active loans, 390,943.87 PUSD, 2,891.49 BCH). Facts confirmed: LE fields, PUSD 2 decimals, collateral = UTXO sats, rate = raw×365/1e5 % per year, price from PriceContractGuarded in cents. Found 54 debt-0 loans still holding 353 BCH (stranded) → new `strandedCount`/`strandedBch` in `/api/loans` summary.

**Sat 21 Nov** —

**Sun 22 Nov** —
