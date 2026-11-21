# Redline docs

Read in this order on a first pull.

| File | Read it for |
|---|---|
| `PRD.md` | What we are building and why, the evidence, scope, acceptance, kill criteria, glossary |
| `review/2026-11-21-ideation-review.md` | The honest check of the idea and the code that led to the current scope |
| `../ARCHITECTURE.md` | System design: components, sign-in protocol, decoding, alerts, stack |
| `SECURITY.md` | Threats and the decisions made against them; checklist before launch |
| `DATABASE.md` | Schema, migrations, retention, and what changed from the architecture sketch |
| `API.md` | Every route, error codes, the mock, and agreed contract changes |
| `DESIGN.md` and `design/tokens.css` | Type, spacing, colour, shape, motion, targets: the foundations, in code |
| `BRAND.md` | Name, voice, identity direction (open decisions marked OPEN) |
| `COMPLIANCE.md` | Age screen, fonts, analytics, legal pages, Pro pass terms; items for a lawyer |
| `PRACTICES.md` | How we work: contract, layout, docs, code, git, reviews |
| `DEPLOY.md` | Railway and Vercel setup, the server variables, the proxy hop count, checks after deploy |
| `../PROGRESS.md` | Gates, plan, decision log |

Precedence when documents disagree: `SECURITY.md` and `DATABASE.md` over `ARCHITECTURE.md`;
`PRD.md` over the plan in `PROGRESS.md`.
