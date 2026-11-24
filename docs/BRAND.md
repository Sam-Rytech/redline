# Redline brand

Status: direction set on 21 Nov 2026 (red as the strong accent, the tachometer object, the
palette and the typefaces). The hero artwork, wordmark and loader are still OPEN: each needs a
yes from the front-end owner at full size before components are built against it.

## What the brand is for

Redline tells a borrower the truth about how close their loan is to the red, early enough to
act. The brand should feel like an instrument panel that someone you trust is watching for
you: calm when things are fine, exact when they are not. It should never feel like a casino
or a panic machine.

Tagline: "Know before your loan hits the red."

## Name and use

- Written "Redline". One word, capital R.
- The line "Independent project, not affiliated with ParyonUSD." appears in the Terms of use
  and the README. Never use Paryon's logo or colours, and never imply endorsement.
- It is a name that explains itself on first read: a red line is the point a gauge warns you
  about. No further explanation is needed on a gallery card.

## Position

For people who borrowed against their BCH, Redline is the thing that watches the price so
they can sleep. It is not a trading tool, a portfolio tracker, or a Paryon dashboard. The
first screen offers two things: sign in with your wallet, or look up any loan without one.

## Voice

Plain, specific, calm. Short sentences. Numbers over adjectives. Say what happens and what to
do.

| Do | Do not |
|---|---|
| "Your loan is 8% from liquidation. BCH at $176.51 or below loses the collateral." | "Warning! Your position is at risk!" |
| "53 loans hold 352 BCH that their owners have not claimed." | "Unlock hidden value in your wallet" |
| "Nothing to do right now. You are 31% above the line." | "You're all set! Stay safe out there" |

Public copy (landing page, README, store text, social posts) is reviewed for plain, accurate
language before it ships. No emojis anywhere in the product, docs or commits.

## Identity direction

- **The object:** one real, life-size race tachometer with a shift light, photographed like a
  studio product shot. It is the main character of the site and the only thing in the hero.
  - The red zone on the dial is the redline the product is named after.
  - The shift light on top is the alarm: it lights as a loan nears the red zone.
  - The dial face is printed for the loan: collateral ratio in %, "BCH / PUSD", and a red
    zone at 110% and below, where Paryon liquidates.
- **Motion:** the object travels through the page as you scroll, vertically and horizontally,
  and the page is built around its path. No people in any shot. Footage is made in Google
  Flow from approved stills; numerals, the logo, the loader and live data stay in code.
- **Hero artwork (OPEN):** GPT stills of the object, approved at full size before the Flow
  clips are made.
- **Wordmark and loader (OPEN):** taken from the object (the red zone arc, the shift light).
- **Palette:** red `#E5321F` as the strong accent; ink `#161513`; concrete `#E9E6E0` as the
  page; steel `#7D7A72` from the bezel, decorative only. Text-size red is `#BE2418`. Risk
  colours (see `design/tokens.css`) appear only on risk chips inside the app. No gradients
  except the object's own lighting, no purple.
- **Typeface:** Archivo Variable (has a width axis; condensed at weight 900 for headlines) and
  JetBrains Mono for small labels, both self-hosted via Fontsource. Body text stays on the
  system stack.
- **Icons:** avoided. Where one is unavoidable, Phosphor in the fill weight for pictorial
  icons and bold for arrows. Never lucide, never thin outline weights.
- **Imagery tone:** photographic product realism, adult, serious about money. No cute
  mascots, no coin clipart.

## Where the red appears

Red is the strong accent: the wordmark, the loader, primary buttons, the red zone on the
object, and the critical risk band. Because red also means danger in the app, the critical
state is never shown by colour alone: it always carries the word "Critical" and the needle's
position in the red zone. Bright red `#E5321F` is for fills and large display type; text at
body size uses `#BE2418`.

## BLAZE banner

A persistent top banner on every page, required by the hackathon: Widget Factory slides link,
repo link, the CashTokens address (`bitcoincash:z...`), and "First commit 20 Nov 2026, no
pre-hackathon code". It is designed once as a slim strip using the same tokens so it reads as
part of the product.

## Assets to produce

| Asset | State |
|---|---|
| Tachometer stills (GPT) | OPEN |
| Object footage (Google Flow, from approved stills) | after the stills |
| Wordmark, app icon and loader (SVG) | OPEN |
| Favicon and social card | after the mark |
| Open Graph image showing a live "N loans within 20% of the line" | after the hero |
