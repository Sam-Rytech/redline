# Redline design foundations

Structure and behaviour follow Apple's Human Interface Guidelines (HIG). Visual identity is
separate and lives in `BRAND.md`. Where the two disagree on surface, identity wins. Where they
disagree on accessibility, input or target size, the HIG wins, and the change is written in
the decision log in `PROGRESS.md`.

The numbers below are decided once. `docs/design/tokens.css` is the code form: components use
its variables and nothing else. Source for the numbers: the HIG typography, layout and color
pages and the web port in the apple-hig skill.

## Platform stance

Mobile first, desktop supported. Alerts arrive in Telegram on a phone and deep-link here, and
the wallet that signs in lives on a phone. On desktop the sign-in screen shows a QR code that
the phone wallet scans. Desktop layouts are a real design, not a stretched phone layout:
hover is never the only way to reach anything, and every control works from the keyboard.

## Type

Four sizes in use. Hierarchy comes from weight and colour first, size second. Display and
title use Archivo Variable (condensed, weight 900, uppercase on the landing page); small
labels use JetBrains Mono; body text uses the system stack. Landing-page headlines may go
above the display size; that is the one written exception.

| Role | Size | Leading | Weight | Use |
|---|---|---|---|---|
| Display | 36px (2.25rem) | 1.07 | 600 | the collateral ratio, liquidation price |
| Title | 28px (1.75rem) | 1.09 | 600 | screen titles |
| Body / Headline | 16px (1rem) | 1.16 in UI, 1.55 in paragraphs | 400 / 600 | everything else |
| Footnote | 13px (0.8125rem) | 1.19 | 400 | chips, captions, legal |

Rules: size in `rem`, zoom is never capped (no `maximum-scale`, no `user-scalable=no`), 12px
is the floor for anything a person must read, and the layout is checked at 200% zoom.
Numbers that people compare (ratios, prices, BCH amounts) use tabular figures
(`font-variant-numeric: tabular-nums`).

## Spacing

`4 8 12 16 20 24 32 40 48 64`, exposed as `--space-1` to `--space-16`. No other values, no
arbitrary pixel offsets. The side gutter is 16px or the safe-area inset, whichever is larger.
Bottom-fixed elements add `env(safe-area-inset-bottom)`.

## Targets

44 by 44px minimum for anything tappable. This is the hit region, not the visual size: an icon
or chip can be smaller if padding brings the target to 44. At least 8px between adjacent
targets. On desktop pointer-only controls may drop to 32px, but never where touch also reaches.

## Colour

Semantic tokens only, both themes, swapped by variable and never restated per component.

- Label tokens: `--label`, `--label-2`, `--label-3`. Measured contrast on the base and
  grouped backgrounds is 5.2:1 at the lowest (label-3 on grouped, light), so all three are
  safe for text.
- Backgrounds in three layers: `--bg-base`, `--bg-grouped`, `--bg-elevated`.
- Red is the strong accent (see `BRAND.md`): the primary action is deep red (`--action-bg`,
  `#BE2418`, bone label at 5.4:1). Bright red `--brand-red` is for fills and large display
  only (3.5:1 on concrete). Because red is also the critical colour, the critical band always
  carries its word and the needle position, never colour alone.
- Page is concrete (`--bg-grouped`), cards are bone (`--bg-base`) or white (`--bg-elevated`).
- Risk bands: safe, watch, danger, critical. Colour never carries meaning alone: every band
  also has a word ("Safe", "Watch", "Danger", "Critical") and a distinct gauge position.
  Each band colour is measured at 4.7:1 or better on its tint and on both backgrounds, in
  both themes.

## Shape and depth

| Token | Value | For |
|---|---|---|
| `--radius-chip` | 6px | chips, risk badges |
| `--radius-control` | 10px | buttons, inputs |
| `--radius-card` | 14px | loan cards, grouped lists |
| `--radius-sheet` | 20px | bottom sheets, modals |

Elevation has three levels: flat content (0), sheets and popovers (1), modals (2). Cards sit
flat on the grouped background; if every card is lifted, nothing is.

Glass (a translucent blurred surface) is for the top bar and the bottom navigation only. It
is never used on loan cards or any content surface. It falls back to a solid surface when
`backdrop-filter` is unsupported, with Reduce Transparency, or with Increase Contrast.

## Motion

Motion only says where something came from or went. 120ms for state changes, 220ms for
things appearing and leaving, 320ms for sheets and modals. Ease out on arrival, ease in on
exit. Under `prefers-reduced-motion` every duration collapses to near zero, and the landing
page shows still frames of the object instead of scroll-driven footage. The gauge moves once
on load to its value and does not loop. The brand loader plays once per session.

## Navigation and modality

Bottom navigation at phone width with three destinations: Loans, Alerts, Account. A modal is
used only when the task must be finished or abandoned (the wallet signing prompt, paying for
the Pro pass). Every modal has an obvious way out, and modals are never stacked. Wallet and
alert responses are shown in modals, in the same way every time.

## States, copy, empties

Every component ships with its states: default, hover, focus-visible, active, disabled,
loading, error, empty. Loading shows structure, not a full-screen spinner.

- Buttons start with a verb that says what happens: "Sign in with wallet", "Connect
  Telegram", "Pay 0.25 USD in BCH".
- Empty states say what would appear, why it is empty, and what to do next.
- Errors say what happened and what the person can do. "Something went wrong" is not a message.
- One or two prominent buttons per view.
- Destructive actions are undoable where possible (removing a watch can be undone for a
  few seconds) and confirmed only where they cannot be.

## Compliance in the design

Self-hosted fonts only (see `COMPLIANCE.md`). The Pro pass terms sit directly beside the pay
button. The age screen, terms, privacy, cookie policy and consent notice ship in the first
build and are linked in the footer on every page.

## Pass before calling any screen done

1. Count the type sizes: more than four needs a written reason.
2. Every spacing value is on the scale.
3. Smallest tap target measured on a 360px-wide viewport.
4. Lightest text contrast measured on its real background.
5. Viewport tag has no zoom cap and includes `viewport-fit=cover`.
6. Loads and works at 200% zoom.
7. Whole page reachable by keyboard with visible focus.
8. Both themes checked.
9. Reduced motion and reduced transparency honoured.
10. Empty states and errors read as sentences.
11. Network tab shows no request to a font or analytics host other than ours.
12. Asked: what would someone call this after seeing it once? If the answer is "a website",
    the identity work in `BRAND.md` has not landed.
