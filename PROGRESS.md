# Redline — Progress & Plan

**Deadline:** Sun 22 Nov 2026, 15:00 Lagos (14:00 UTC). **Internal freeze: Sun 11:00 Lagos. Submit by 13:00.**
**Team:** Dev A (Sam) — sign-in, payments, front end. Dev B (teammate) — Paryon decoder, chain reader, alerts, Telegram bot.
All times are Lagos (UTC+1). Update this file at the end of every work block.

Status legend: ⬜ not started · 🟨 in progress · ✅ done · ❌ failed/blocked

---

## Hard gates

A gate is a yes/no check. **If a gate fails, stop and decide before building further.** Each has a fallback so a failure is a detour, not a dead end.

| # | Gate | Deadline | Pass condition | If it fails | Status |
|---|---|---|---|---|---|
| G0 | Accounts & funds | Tue 23:59 | Repo created; BUIDL draft created on DoraHacks; Paytaca + Selene installed, each with ~$0.50 BCH; Telegram bot token from @BotFather | Ask in BLAZE Telegram for a few cents (others have been tipped) | ⬜ |
| G1 | `broadcast:false` honoured | Wed 13:00 | Paytaca **and** Selene return a signed tx without broadcasting it (tx not visible on an explorer after 2 min) | Switch sign-in to fallback mode (tiny real self-payment, ~300 sats). Note which wallet broadcasts in the README | ⬜ |
| G2 | Loan decode matches | Wed 18:00 | For 5 live loans, decoded debt, collateral BCH, rate and liquidation price equal stats.paryonusd.com exactly | Fix units/endianness. If still wrong by Thu 12:00, ask in Paryon Telegram for the field units | ⬜ |
| G3 | Sign-in works end to end | Thu 18:00 | Same wallet signs in on laptop and phone → same account. Reused nonce and expired nonce are rejected | Ship fallback mode only; keep going | ⬜ |
| G4 | Real alert fired | Fri 15:00 | A Telegram alert is sent from real mainnet data (use a low test threshold on a real loan) | Cut rules down to liquidation-distance only | ⬜ |
| G5 | Mainnet payment by an outsider | Fri 21:00 | Someone outside the team pays the Pro subscription on mainnet from their own wallet; Pro activates | BCH-only payment; PUSD payment becomes stretch | ⬜ |
| G6 | Outside testers | Sat 18:00 | 3 people from the BLAZE group complete: open site → sign in or watch a loan → connect Telegram, without help | Fix the top 3 confusions before anything else | ⬜ |
| G7 | Submission complete | Sun 13:00 | Every item in the Submission checklist below ticked | — | ⬜ |

---

## Day-by-day plan

### Tue 17 Nov (tonight) — Day 0: setup
- [x] **Both:** read ARCHITECTURE.md; name agreed: **Redline**
- [ ] **A:** create GitHub repo (pnpm workspaces: `apps/web`, `apps/server`, `packages/wizard-login`, `packages/paryon-decoder`); first commit after 14 Nov ✔
- [ ] **A:** create DoraHacks BUIDL draft now (3-BUIDL limit for new accounts)
- [ ] **B:** create Telegram bot with @BotFather, keep the token private
- [ ] **Both:** install Paytaca + Selene on phone; switch on CashTokens addresses; fund each with ~$0.50 BCH
- [ ] **A:** copy the Widget Factory slides (File → Make a copy)
- [ ] Gate **G0**

### Wed 18 Nov — Day 1: prove the two risky assumptions
Morning
- [ ] **A:** minimal page: WizardConnect connect → show wallet name + derived receive addresses (pin `@wizardconnect/dapp` + `core` to the same exact version)
- [ ] **A:** build the login tx (self-spend + OP_RETURN) with CashScript, send with `broadcast:false` → **G1** on Paytaca and Selene
- [ ] **B:** compute the Loan contract address from `@paryonusd/contracts@1.1.0`; `listunspent` on Fulcrum; filter 27-byte `0x01` commitments
Afternoon
- [ ] **B:** decode fields; read collateral from UTXO sats; get price (price contract or oracles.cash) → **G2**
- [ ] **A:** server skeleton (Hono + SQLite), `/auth/challenge`, `/auth/verify` with libauth VM verification
- [ ] **Both:** 15-min sync at 19:00 — update gates table
- [ ] Post Telegram intro in BLAZE group (no roll-call questions)

### Thu 19 Nov — Day 2: sign-in + loans
- [ ] **A:** finish verification checks (domain, nonce, expiry, unused, address ↔ xpub, unspent-or-spent-by-this-tx); session cookie; `/me`
- [ ] **A:** `packages/wizard-login` clean API + README with a 10-line usage example
- [ ] **B:** chain reader on new blocks; `loan_snapshots`; metrics: CR, liq price, distance, debtAhead, redemptionInProgress, pendingRateChange, stranded
- [ ] **B:** loan ↔ loan key mapping via sidecar (`vout+1`); `/me/loans` from the user's token UTXOs
- [ ] **A:** web: Landing, Sign in, My loans cards, Watch any loan table
- [ ] Deploy server (Railway) + web (Vercel) — even if ugly
- [ ] **G3** by 18:00
- [ ] Evening: post the `wizard-login` widget in the BLAZE group ("free for any WizardConnect app")

### Fri 20 Nov — Day 3: alerts + payment
- [ ] **B:** Telegram linking (`/start <token>`), alert engine with bands + hysteresis, `/status` `/mute` → **G4** by 15:00
- [ ] **A:** invoices: persist chosen inputs, build payment tx, `broadcast:true`, server confirms, Pro activates; retry reuses inputs ("Already paid ✓")
- [ ] **A:** BCH payment first; PUSD payment only if BCH is done by 16:00
- [ ] **G5** by 21:00 — ask one BLAZE builder to pay from their own wallet
- [ ] **Both:** fix whatever broke in deploy

### Sat 21 Nov — Day 4: polish + outside eyes
- [ ] Ask 3 BLAZE builders to try it (offer to test theirs in return) → **G6** by 18:00
- [ ] Fix top confusions; sign-in explainer text; empty states; mobile layout
- [ ] Landing live counter ("N loans within 20% of liquidation")
- [ ] Banner on every page (slides link, repo, `bitcoincash:z…` address, "no pre-hackathon code")
- [ ] Finish Widget Factory slides
- [ ] 15:00 — final check-in stream (watch for last-minute rule notes)
- [ ] Post demo on X + BLAZE Telegram (word of mouth matters)

### Sun 22 Nov — Day 5: ship
- [ ] 09:00–11:00 only bug fixes. **11:00 freeze** — no new features
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

- [ ] PUSD subscription payment
- [ ] Duplicate loan-key warning (needs a Chaingraph endpoint)
- [ ] Interest-erosion projection ("at this rate your liq price rises to $X in 30 days")
- [ ] In-app "add collateral" via Paryon artifacts

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Wallets ignore `broadcast:false` | Medium | Low | Fallback self-payment sign-in (G1) |
| Field units/endianness wrong | Medium | High | G2 on day 1; compare with stats site |
| Collateral not equal to UTXO sats | Low | High | G2; fall back to sidecar/stats reading |
| Price contract address unknown | Medium | Medium | oracles.cash fallback |
| WizardConnect package churn | Medium | Medium | Exact version pins, commit lockfile |
| Host sleeps, alerts stop | Medium | High | Always-on host (Railway/VM) |
| Teammate availability | ? | High | Daily 19:00 sync; A can take over decoder (pure functions) |

---

## Decision log

| Date | Decision | Why |
|---|---|---|
| 17 Nov | Build the PUSD loan-alert app (now Redline) with WizardConnect login as its sign-in (one submission) | Documented gaps in both ParyonUSD and WizardConnect docs; outside the crowded payments field; strongest "will it make money" |
| 17 Nov | No in-app loan actions in v1 | Paryon contracts are complex (26 contracts, sidecars); deep-link instead |
| 17 Nov | BCH payment before PUSD payment | Judges may not hold PUSD |
| 20 Nov | Renamed to **Redline** | Avoids looking like an official Paryon product; "Canary" and "Watchtower" already taken in BTC/BCH |
| 20 Nov | Payment is a one-time **30-day Pro pass**, not a recurring charge | It is the required mainnet tx and the "will it make money" proof; no auto-renew to build |

---

## Daily log

**Tue 17 Nov** — Idea chosen, architecture written.

**Wed 18 Nov** —

**Thu 19 Nov** —

**Fri 20 Nov** — Renamed to Redline; payment labelled "30-day Pro pass".

**Sat 21 Nov** —

**Sun 22 Nov** —
