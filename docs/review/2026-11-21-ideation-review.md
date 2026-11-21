# Redline: ideation review, 21 Nov 2026

Method: the team's ideation procedure applied to an existing idea (triage), plus a read of the
code on `main` at commit 8b5e458. Everything marked unverified was not checked.

Brief: BCH BLAZE 2026. The 2026 judging criteria, prize structure and field size could not be
found, only the 2025 edition. Unverified. If someone pastes the DoraHacks page, score against it.

## The idea, as a problem statement

Some ParyonUSD borrowers can lose all their collateral, or leave collateral behind, without
being told.

## The three tests

| Test | Result |
|---|---|
| Push: frustration in their words | Not found. No borrower complaint or reported liquidation was found. The evidence is the protocol docs, which is reasoning, not complaint. |
| Workaround: what people do today | Plausible and undocumented: checking stats.paryonusd.com by hand or generic price alerts. |
| Cost | Real. Liquidation takes the collateral. Lowest-CR loans on 21 Nov were about 7% from it. |

Classification: an idea with a real cost and unproven push. Not yet a proven problem.

## Beneficiary

"After this exists, a borrower stops having to watch a price page to avoid losing their BCH."
The sentence finishes and the user is the buyer. The market is at most about 141 active loans.

## Tarpit check

Why has no one done it, or why would it not last? Paryon can add alerts to its own app for
free; sophisticated borrowers already run price bots; and about 141 loans cannot pay for a
business. The Pro pass is a proof of payment for the hackathon, not revenue.

## Posture

Build on top of an existing protocol. The alert app is thin: anyone could copy it. The only
thick piece is `wizard-login`, because WizardConnect has no message signing and every
WizardConnect app therefore lacks wallet login. That is infrastructure, chosen deliberately.

## Findings that change the plan

1. **Stranded collateral is the best-evidenced problem.** On 21 Nov, 53 loans with zero debt
   held 352.8 BCH (about $67k). The Paryon docs say there is no automatic payout. The plan had
   this as a stretch item because of the calendar; the calendar must not decide scope, so it
   is promoted to a must. Not verified: whether the owners can claim it and whether they know.
2. **Count real liquidations from open chain data** before building the alert engine. It
   decides how much weight alerts deserve.
3. **`wizard-login` is reusable** by other BLAZE teams and the alert engine works for any
   CashTokens vault: one build, several submissions.

## Code review findings

| # | Finding | Status |
|---|---|---|
| 1 | Cookies across Vercel and Railway. Correction after re-reading `docs/API.md`: it already specifies Vercel rewrites so the cookie stays same-origin, which resolves this. The server must still not need CORS, and the rewrite must be in the web app's config. | Closed by design; captured in `SECURITY.md` |
| 2 | Sign-in relay: a challenge could be answered from another browser | Fixed in design: challenge bound to the browser (`SECURITY.md`, `DATABASE.md`). Not yet in code |
| 3 | False "loan gone" alerts from partial chain reads | Fixed in design (3 consecutive misses, 80% rule). Not yet in code |
| 4 | `/api/loans` does not say when data is stale | Added to the API contract. Not yet in code |
| 5 | Plan stores both xpubs in `accounts` | Changed: hash only; xpubs live in the session |
| 6 | Rates rounded to 2 decimals before the redemption-queue comparison | Compare raw values. Not yet in code |

## What was good

The decoder matches the live protocol (checked against mainnet on 21 Nov: 141 active loans,
377,386 PUSD debt, 2,851 BCH collateral). The reader keeps the last good state, times out
stalled fetches and refuses an empty refresh. 57 tests pass and typecheck is clean.

## Kill criteria

See `docs/PRD.md` section 4.
