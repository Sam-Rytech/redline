# Redline compliance defaults

Engineering baseline, built into the first version of each feature. This is not legal advice.
Items marked LAWYER need a person with legal training before public launch.

## Age check at sign-up (COPPA)

COPPA is the US rule protecting children under 13. Redline signs in with a wallet, so there is
no sign-up form; the age screen sits between "Sign in with wallet" and the first challenge.

- Ask for date of birth with no hint about a cutoff and no "you must be 13" text.
- Under 13: blocked. Redline is not a product for children, so there is no parental consent
  route.
- A failed check is remembered in a cookie (`rl_age`) and in the session, so going back and
  editing the date does not pass.
- Only the result is stored (`accounts.age_ok`). The date of birth is discarded after the
  comparison.
- LAWYER: the threshold is 13 to 16 in the EU and UK, and Nigeria's data protection law treats
  under 18 as children. If Redline serves those users, the cutoff may need to be higher.

## Fonts never leak the visitor's IP

Every font is self-hosted. No request to `fonts.googleapis.com` or `fonts.gstatic.com` at any
time. Default is the system font stack; any identity font ships through Fontsource or a
committed `.woff2`. Check the network tab before calling a page finished (`DESIGN.md` pass,
item 11).

## Analytics without session replay

Use cookieless analytics: Plausible, Umami or Fathom. No session replay tool. If one is ever
added, replay is switched off in config, input capture is masked, it loads only after consent,
and turning it on is the owner's decision. Default for Redline: Plausible, no cookies.

## Legal pages ship with the build

Terms, privacy policy, cookie policy and a consent notice, linked in the footer from the first
build. Required content specific to Redline:

- **Terms:** independent project, not affiliated with ParyonUSD; alerts are best effort, can be
  late or missed, and are not financial advice; the Pro pass terms below. LAWYER.
- **Privacy:** what is stored (account hash, plan, Telegram chat id, watches, alert history,
  session), that signing in reveals one UTXO and the wallet's xpubs to our server for the
  session only, retention, and `DELETE /api/me`. LAWYER.
- **Cookies:** `rl_session` and `rl_ch` and `rl_age` are strictly necessary. No tracking
  cookies. A notice banner is still shipped.

## Pro pass terms next to the pay button

Redline's pass is one payment with no renewal, so the rule for subscriptions (ROSCA,
California auto-renewal law, App Store 3.1.2) is met by saying that plainly, beside the button:

> Pro pass: 0.25 USD, paid once in BCH (about N BCH at today's price). Lasts 30 days. Does not
> renew. You are not charged again. Nothing to cancel.

Not behind a link and not only in the terms. A payment confirmation repeating these terms is
shown on screen and sent to the linked Telegram chat.

Built: every invoice carries the terms (`Invoice.terms`, `docs/API.md`), and the server sends
the receipt to the linked Telegram chat once, when the payment is confirmed. The on-screen
receipt is the web app's part.

DECISION NEEDED: the standing rule asks for a confirmation email. Redline deliberately
collects no email. Proposed substitute: on-screen receipt plus Telegram message. If the
owner wants an email too, an email field must be added to sign-up and the marketing-email
rules below apply.

## Newsletter and marketing email

Not applicable today: Redline sends no email. If that changes, every message needs a visible
unsubscribe link, a physical postal address from config (a missing one fails the send),
`List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers, and a
one-step unsubscribe with no login. Built once in a shared footer and send function.

## Open for the owner

1. Lawyer for the terms, privacy and age thresholds above.
2. Whether to collect an email for payment confirmations.
3. Whether Telegram alerts count as "marketing" for the target countries: they are
   transactional by design and carry no promotion.
