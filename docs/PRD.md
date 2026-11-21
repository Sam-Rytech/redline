# Redline: product requirements

Owner: Sam (back end, product), front-end owner for `apps/web`. Last updated 21 Nov 2026.
How this was reached: `docs/review/2026-11-21-ideation-review.md`.

## 1. Words used in this document

- **ParyonUSD (Paryon):** a lending protocol on Bitcoin Cash. You lock BCH as collateral and
  borrow PUSD, a dollar-pegged token.
- **Loan:** one on-chain position: BCH locked, PUSD owed, an interest rate.
- **Collateral ratio (CR):** collateral value in dollars divided by debt in dollars. 150% means
  the BCH is worth one and a half times what you owe.
- **Liquidation:** if CR falls below 110%, the loan is closed by the protocol and the borrower
  loses the collateral. There is no appeal and no grace period.
- **Liquidation price:** the BCH price at which that happens: debt / BCH locked x 1.1.
- **Redemption:** anyone can swap PUSD for collateral of the lowest-interest loans first,
  which can shrink or close a borrower's loan without their action.
- **Stranded collateral:** a loan whose debt was fully redeemed to zero but which still holds
  BCH. The Paryon docs say there is no automatic payout; the owner has to claim it.
- **Wallet sign-in:** proving you control a wallet without a password. Redline asks the wallet
  to sign a transaction that is never sent.
- **WizardConnect:** the protocol that links a website to a phone wallet (Paytaca, Selene).
- **xpub:** a public key from which every address of a wallet can be derived. It reveals the
  wallet's whole history, so it is handled as sensitive.
- **CashTokens:** Bitcoin Cash's native token and NFT format. Paryon loans are CashTokens.

## 2. The problem

Written without a solution in it: borrowers on Paryon can lose all their collateral, or
leave collateral behind, without being told.

Evidence, labelled by strength:

| Claim | Evidence | Strength |
|---|---|---|
| Liquidation takes all collateral with no warning | Paryon borrowing docs | Strong (protocol fact) |
| Borrowers sit close to the line | Live read, 21 Nov: lowest CR loans at 118.7% to 119.6%, about 7% from liquidation at $190.50 | Strong |
| 53 loans hold 352.8 BCH (about $67k) at zero debt | Live read, 21 Nov | Strong that it exists. Not verified: whether owners can claim it, or already know |
| Borrowers want alerts | None found: no complaint, no workaround observed | Thin. This is the open question. |
| Number of liquidations that have actually happened | Not yet counted | Unknown |

Honest classification (see the review): today the alert idea is a plausible problem with
unproven push. Stranded collateral is the best-evidenced piece.

How might we help a borrower find out about a danger to, or money owed on, their loan before
it costs them?

## 3. Users

- **Borrower with a loan** (primary): has a Paryon loan, uses Paytaca or Selene. Wants to
  stop checking a price page to stay safe.
- **Borrower with unclaimed collateral**: does not know a redeemed loan still holds BCH.
- **Observer** (judges, curious users): has no loan. Must still be able to try the product
  with no wallet, through "Watch any loan".
- **Other BLAZE developers** (secondary): want wallet login in their own WizardConnect app,
  through the `wizard-login` package.

## 4. Outcome and kill criteria

Outcome: a borrower with a loan gets a Telegram message before liquidation, and a borrower
with stranded BCH is shown it on sign-in.

| | Measure | Number |
|---|---|---|
| Success | Real borrowers with a live watch, not counting the team | 10 |
| Success | A message arrives in Telegram within one block (about 10 minutes) of a threshold crossing, from real mainnet data | tested once on a real loan |
| Success | Outsiders who pay the Pro pass on mainnet | 1 |
| Fail | After the on-chain liquidation count: zero liquidations since launch AND the stranded loans prove not to be claimable | stop building the alert app; keep `wizard-login` |
| Fail | After public launch, 14 days with fewer than 3 borrowers who are not the team | pivot or stop |

Reset question at each checkpoint: if starting from scratch today, would we build this? If
no, every further day is a new loss.

## 5. Scope

### Must have

1. **Loans view:** public read of all loans: CR, liquidation price, distance, risk band, debt
   ahead in the redemption queue. Live from BCH mainnet, refreshed about every minute, with a
   visible "data is N minutes old" state.
2. **Watch any loan:** no sign-in needed to browse and search every loan.
3. **Stranded collateral:** the count and BCH total shown on the landing page, and on a
   signed-in borrower's loan card with a link to claim in the official Paryon app. Promoted
   from stretch to must (see decision log).
4. **Wallet sign-in:** Paytaca and Selene through WizardConnect, no password and no email,
   per `SECURITY.md`.
5. **Alerts, two rules:** liquidation distance (bands at 25%, 15%, 8% with re-arm) and loan
   gone. Delivered by Telegram.
6. **Telegram link:** one-time link token; commands `/status`, `/mute`, `/help`.
7. **Free and Pro:** free = 1 watch; Pro = unlimited. Pro pass is a 30-day, one-time BCH
   payment worth 0.25 USD, with the terms shown beside the button (`COMPLIANCE.md`).
8. **Age screen** before the first sign-in, and legal pages, consent notice and the BLAZE
   banner on every page.

### Should have (stretch, in this order)

1. Alert rules: redemption queue, redemption started, rate change, stranded appears.
2. PUSD payment for the Pro pass.
3. Duplicate loan-key warning (needs Chaingraph, a public chain index; not yet verified).
4. Interest-erosion projection.

### Not building

Acting on loans in the app (deep links to Paryon instead), stability-pool monitoring, email
or SMS alerts, any custody of keys or funds.

## 6. Requirements with acceptance

| # | Requirement | Acceptance |
|---|---|---|
| R1 | Loan numbers match the protocol | 5 loans decoded equal stats.paryonusd.com exactly (done 20 Nov) |
| R2 | A partial chain read never causes a false alert | A loan is reported gone only after 3 consecutive successful reads without it, and a read that drops more than 20% of loans is discarded |
| R3 | Stale data is never silent | `/api/loans` carries `stale`, and the UI shows the age of the data |
| R4 | Sign-in cannot be relayed | A challenge answered from a different browser than the one that asked is rejected |
| R5 | Same wallet, same account | Laptop and phone sign-in give the same account id |
| R6 | Alerts fire once per band | Crossing 25% then staying below sends one message; recovering by 3% re-arms |
| R7 | Pay once, Pro once | Retrying a payment cannot charge twice; reload shows "Already paid" |
| R8 | Under-13 blocked | Changing the date after a failed check does not pass |
| R9 | No third-party font or analytics requests | Network tab shows only our origin, plus Plausible if consent allows |
| R10 | A person can delete their account | `DELETE /api/me` removes the account, sessions, watches, Telegram link |

## 7. Risks

| Risk | Impact | Response |
|---|---|---|
| Push for alerts is unproven | The main feature has no users | Count liquidations first; lead with stranded BCH; kill criteria above |
| Paryon adds alerts in its own app | Redline duplicates it | Keep Redline useful without a Paryon account: any-loan lookup, `wizard-login` for others |
| Wallets ignore "do not send" | A small self-payment appears | Verification accepts both outcomes; the cost to the user is about 300 satoshis |
| Fulcrum (public chain server) returns bad data | False alerts | R2 |
| Alerts are missed or late | A borrower relies on it and loses money | Say plainly it is best effort and not advice (legal pages; lawyer to review) |
| Tiny market (about 141 loans) | No business | Treat the Pro pass as a proof of payment, not revenue |

## 8. Open questions

1. How many liquidations have happened since 30 Apr 2026?
2. Are the 53 stranded loans claimable by their owners, and do the owners know?
3. Does the Paryon app URL in `PARYON_APP_URL` exist as written?
4. Final judging criteria for BCH BLAZE 2026 (only the 2025 edition could be found).
5. Who is the lawyer for the age, privacy and "not financial advice" pages? Flagged in
   `COMPLIANCE.md`.
