# How we work on Redline

Proposed team practices. Agree or change them in the team chat, then this file is the rule.

## Contract between back end and front end

- `packages/api-types` is the contract. A type change is announced in the team chat in the
  same hour, and `docs/API.md` is updated in the same commit.
- The front end builds against the mock (`pnpm dev:mock`) until the matching real route exists.
  Mock and real server return the same shapes.
- The browser only calls relative `/api/...` URLs. Never a hard-coded host.

## Repository layout

```
apps/web         front end (React, Vite)
apps/server      API, chain reader, alert engine, Telegram bot, SQLite
apps/mock-api    mock of the API for the front end
packages/        api-types, paryon-decoder, wizard-login
docs/            what a teammate reads on pull: PRD, security, database, API, design, brand
workbench/       gitignored scratch: plans, experiments, one-off scripts, moodboards, drafts
```

Nothing that is not the product or its documentation goes at the repo root. Plans, progress
notes, asset briefs, design reviews, demo scripts and one-off scripts go in `workbench/`.
(`ARCHITECTURE.md` and `PROGRESS.md` predate this rule and stay at the root until we agree to
move them.)

## Documentation

- Docs say what is true now. When code changes behaviour, the doc changes in the same commit.
- Every setting listed in a doc or `.env.example` is read by code. Remove it when the code stops.
- Explain terms the first time they are used. Assume the reader has not seen the protocol.
- No emojis in documentation, interface copy or commit messages.
- README is for someone using or running the product: what it is, how it works, how to run it,
  configuration, layout. Hosting limits, internal costs and outreach plans stay in `workbench/`.
- Anything a person outside the team will read (landing copy, README, posts, submission text)
  goes through the content-writer skill and its scanner first. Internal docs do not.

## Code

- Comments say what the code does, briefly. No task ids, no history ("used to be..."), no
  private paths, no names of people.
- TypeScript strict. No `any` without a one-line reason.
- Exact dependency versions, lockfile committed. A new dependency is mentioned in the PR.
- Never log xpubs, signed transaction hex, cookies or tokens (`SECURITY.md`).

## Interface

- Foundations are in `docs/DESIGN.md` and `docs/design/tokens.css`. Components use tokens and
  nothing else.
- Run the pass at the end of `DESIGN.md` before calling a screen done, with both themes.
- Illustrations and real imagery over icon grids. If an icon is unavoidable, Phosphor fill
  for pictorial icons and bold for arrows. Not lucide.

## Git

- Work on a branch; `main` stays deployable. Open a PR, the other person reviews.
- Commit messages are short and say what changed. Agree the message before committing when
  more than one person is working in the same area. No tool or assistant attribution lines.
- Small commits over large ones. Stage by name, never `git add -A`, and check the staged files
  against these rules first.
- The shared `.gitignore` holds project patterns only (env files, dependencies, build output,
  `workbench/`). Personal or tool files go in your own `.git/info/exclude`.

## Reviews

- A reviewer checks the change against `PRD.md` requirements and `SECURITY.md`, not only that
  it runs.
- A finding is reported once.

## Compliance

`docs/COMPLIANCE.md` applies from the first version of any feature it touches. The age screen,
legal pages, self-hosted fonts, cookieless analytics and the Pro pass terms are not a later
phase.

## Blockers

A blocker is raised in the team chat immediately, in plain words, with what is needed and from
whom. It is not left only in a file.
