# @redline/web

The Redline front end: React, Vite, TypeScript and CSS Modules on the tokens in `src/styles/tokens.css`
(a copy of `docs/design/tokens.css`).

## Run

```sh
pnpm install
pnpm dev:mock                      # mock API on :8787
pnpm --filter @redline/web dev     # app on :5173, /api proxied to the mock
```

In development the sign-in and Pro pass screens offer a demo wallet that talks to the mock API. Production
builds hide it; real signing comes with WizardConnect.

## Layout

```
src/
  app/        router, shell (banner, top bar, footer, cookie notice)
  ui/         shared pieces, one folder each: Button, Card, Chip, Sheet, Case, Gauge, Loader, Wordmark
  features/   one folder per area: landing, loans, auth, account, legal
  lib/        API client, data hooks, formatting, gauge maths
  assets/     the tachometer and plug stills (cut-out WebP)
```

## Rules

- A component lives in its own folder with its `.module.css` and an `index.ts`. Features import from `ui/` and
  `lib/`, never from another feature, except `loans` cards and detail, which `account` reuses.
- Styles use token variables only: no raw hex outside `tokens.css` and the photographed object, no spacing off
  the scale.
- Watches and alert rules update optimistically and roll back with a reason. Sign-in and payment never do; they
  show a pending state until the server confirms.
- Risk is never shown by colour alone: every band has its word.
- `prefers-reduced-motion` turns off the loader, the scroll motion and the needle spring.

## The gauge

`ui/Gauge` stacks two photographs of the same dial (lamp off and lamp on) and draws the needle in SVG. The
needle angle comes from `lib/gauge.ts`, which maps collateral ratio to the printed scale; the lamp lights within
15 points of the 110% liquidation line.
