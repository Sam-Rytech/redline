# API Contract + Mock Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock the front end (jadonamite) by Fri 20 Nov 17:00 Lagos: a pnpm monorepo, a shared `api-types` package that is the contract for every endpoint, the pure risk-metric functions, and a mock API server with realistic loan data.

**Architecture:** pnpm workspaces. `packages/api-types` holds TypeScript types only (plus 3 constants). `packages/paryon-decoder` starts with the pure metric functions from ARCHITECTURE.md §3.2 (the real decoder is added later against the same output type). `apps/mock-api` is a Hono server with in-memory state that implements every endpoint with fixture data built through the real metric functions. It is a separate app so the front end never installs the real server's native dependencies (`better-sqlite3`). All routes live under `/api`, so the web app calls a relative `/api/...` both locally (Vite proxy) and in production (Vercel rewrite to Railway), which keeps the session cookie same-origin.

**Tech Stack:** Node ≥ 20 (dev machine has 22), pnpm 11, TypeScript 7.0.2, Hono 4.13.19 + @hono/node-server 2.1.11, Vitest 5.1.1, tsx 4.23.15.

**Spec:** `ARCHITECTURE.md` (§3.2 metrics, §3.3 API, §4 data model), `PROGRESS.md` (roles, scope cuts).

## Global Constraints

- Pin every dependency to an exact version (no `^`/`~`) — ARCHITECTURE §5 / gotcha 1.
- All HTTP routes are under the prefix `/api`.
- Money in the API is in human units: PUSD as a decimal number (2 decimals on chain), BCH as a decimal number; satoshis as integer `number`.
- Never expose xpubs in any response (ARCHITECTURE §6).
- Liquidation happens below 110% CR; `liqPrice = debt / collateralBCH × 1.1`.
- Risk bands use distance to liquidation: `safe` ≥ 25%, `watch` 15–25%, `danger` 8–15%, `critical` < 8% (alert bands from §3.3).
- Free plan = 1 watch; Pro = unlimited (PROGRESS scope cuts).
- Footer copy elsewhere: "Independent project, not affiliated with ParyonUSD".

---

## File Structure

```
package.json                     root: workspace scripts, devDeps (typescript, vitest, tsx)
pnpm-workspace.yaml              apps/*, packages/*
tsconfig.base.json               shared compiler options
packages/api-types/
  package.json
  src/index.ts                   ALL request/response types + API_PREFIX, FREE_WATCH_LIMIT, PARYON_APP_URL
packages/paryon-decoder/
  package.json
  src/metrics.ts                 computeMetrics(), riskBand(), debtAhead()
  src/index.ts                   re-exports
  test/metrics.test.ts
apps/mock-api/
  package.json
  src/fixtures.ts                seeded PRNG + makeLoans()
  src/state.ts                   in-memory store (sessions, watches, invoices, account)
  src/app.ts                     Hono app with every route (exported for tests)
  src/main.ts                    starts the server on PORT (default 8787)
  test/app.test.ts
docs/API.md                      human-readable endpoint list + how to run the mock
```

---

### Task 1: Monorepo scaffold + `api-types`

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`
- Create: `packages/api-types/package.json`, `packages/api-types/tsconfig.json`, `packages/api-types/src/index.ts`

**Interfaces:**
- Produces: every type below, imported as `import type { LoanView, ... } from "@redline/api-types"`; constants `API_PREFIX = "/api"`, `FREE_WATCH_LIMIT = 1`, `PARYON_APP_URL`.

- [ ] **Step 1: Root files**

`package.json`:
```json
{
  "name": "redline",
  "private": true,
  "packageManager": "pnpm@11.13.1",
  "engines": { "node": ">=20" },
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "dev:mock": "pnpm --filter @redline/mock-api dev"
  },
  "devDependencies": {
    "@types/node": "26.6.6",
    "tsx": "4.23.15",
    "typescript": "7.0.2",
    "vitest": "5.1.1"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

- [ ] **Step 2: `packages/api-types`**

`packages/api-types/package.json`:
```json
{
  "name": "@redline/api-types",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p .", "test": "echo no tests" }
}
```

`packages/api-types/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/api-types/src/index.ts`:
```ts
// Redline API contract. Every route is under API_PREFIX.
// Changing anything here = tell the other side in the team chat.

export const API_PREFIX = "/api";
export const FREE_WATCH_LIMIT = 1;
/** Official Paryon dApp; alerts and loan cards deep-link here. ⚠ VERIFY URL. */
export const PARYON_APP_URL = "https://app.paryonusd.com";

// ---------- shared ----------
export type ISODate = string; // e.g. "2026-11-20T12:00:00.000Z"
export type Hex = string;

export interface ApiError {
  error: { code: string; message: string };
}

export interface Outpoint {
  txid: Hex;
  vout: number;
}

// ---------- loans ----------
export type LoanStatus = "new" | "single-period" | "mature";
export type RiskBand = "safe" | "watch" | "danger" | "critical";

export interface LoanView {
  /** loanTokenId (hex category of the loan's sidecar NFT). Stable id. */
  id: Hex;
  status: LoanStatus;
  debtPusd: number;
  collateralSats: number;
  collateralBch: number;
  /** Annual % e.g. 1.5 means 1.5% */
  interestRatePct: number;
  nextInterestRatePct: number;
  pendingRateChange: boolean;
  /** Percent, e.g. 132.4. null when debt is 0. */
  collateralRatioPct: number | null;
  /** USD per BCH at which this loan hits 110% CR. null when debt is 0. */
  liquidationPriceUsd: number | null;
  /** (price − liqPrice) / price, 0..1 (negative = liquidatable). null when debt is 0. */
  distanceToLiquidation: number | null;
  risk: RiskBand;
  /** PUSD redeemed before this loan (lower-rate loans + loans under 100 PUSD). */
  debtAheadPusd: number;
  redemptionInProgress: boolean;
  amountBeingRedeemedPusd: number;
  /** debt == 0 but collateral left behind */
  stranded: boolean;
  /** Deep link to act on this loan in the official dApp */
  paryonUrl: string;
}

export interface LoansSummary {
  total: number;
  /** Landing counter: loans with distanceToLiquidation < 0.20 */
  within20pct: number;
  totalCollateralBch: number;
  totalDebtPusd: number;
}

/** GET /api/loans */
export interface LoansResponse {
  blockHeight: number;
  priceUsd: number;
  updatedAt: ISODate;
  summary: LoansSummary;
  loans: LoanView[];
}
/** GET /api/loans/:id → LoanView (404 ApiError) */
/** GET /api/me/loans → LoanView[] (401 if not signed in) */

// ---------- auth ----------
export type AddressPathName = "receive" | "change";

/** POST /api/auth/challenge */
export interface ChallengeRequest {
  xpubReceive: string;
  xpubChange: string;
  outpoint: Outpoint;
  path: [AddressPathName, number];
}
export interface ChallengeResponse {
  nonce: Hex; // 16 bytes
  expiry: number; // unix seconds
  domain: string;
}

/** POST /api/auth/verify → MeResponse (sets HttpOnly cookie) */
export interface VerifyRequest {
  signedTxHex: Hex;
}

/** GET /api/me (401 if not signed in). POST /api/auth/logout → { ok: true } */
export interface MeResponse {
  accountId: Hex;
  pro: boolean;
  proUntil: ISODate | null;
  telegramLinked: boolean;
  /** null = unlimited */
  watchLimit: number | null;
}

/** GET /api/utxos?addresses=a,b,c */
export interface Utxo {
  txid: Hex;
  vout: number;
  address: string;
  satoshis: number;
  height: number; // 0 = unconfirmed
  token: null | {
    category: Hex;
    amount: string; // bigint as string
    nft: null | { capability: "none" | "mutable" | "minting"; commitment: Hex };
  };
}

// ---------- watches ----------
export interface WatchRules {
  liquidation: boolean;
  loanGone: boolean;
}

export interface Watch {
  id: string;
  loanId: Hex;
  rules: WatchRules;
  lastBand: RiskBand | null;
  createdAt: ISODate;
}

/** GET /api/watches → Watch[] */
/** POST /api/watches (403 code "watch_limit" when over FREE_WATCH_LIMIT) */
export interface CreateWatchRequest {
  loanId: Hex;
  rules?: Partial<WatchRules>;
}
/** PATCH /api/watches/:id → Watch */
export interface UpdateWatchRequest {
  rules: Partial<WatchRules>;
}
/** DELETE /api/watches/:id → { ok: true } */

// ---------- telegram ----------
/** POST /api/telegram/link-token */
export interface TelegramLinkResponse {
  token: string;
  url: string; // https://t.me/<bot>?start=<token>
  expiresAt: ISODate;
}

// ---------- invoices (30-day Pro pass) ----------
export type InvoiceStatus = "open" | "paid" | "expired";

export interface Invoice {
  id: string;
  status: InvoiceStatus;
  asset: "BCH";
  amountSats: number;
  merchantAddress: string; // bitcoincash:z…
  /** OP_RETURN payload hex: "PWINV" | id */
  opReturnHex: Hex;
  /** Inputs the client must reuse on any retry */
  inputs: Outpoint[];
  txid: Hex | null;
  createdAt: ISODate;
  paidAt: ISODate | null;
}

/** POST /api/invoices */
export interface CreateInvoiceRequest {
  asset: "BCH";
  inputs: Outpoint[];
}
/** GET /api/invoices/:id → Invoice */
/** POST /api/invoices/:id/submit → Invoice */
export interface SubmitInvoiceRequest {
  signedTxHex: Hex;
}

export interface OkResponse {
  ok: true;
}
```

- [ ] **Step 3: Install and typecheck**

Run: `pnpm install` then `pnpm --filter @redline/api-types typecheck`
Expected: exits 0, no output from tsc. Commit `pnpm-lock.yaml`.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json pnpm-lock.yaml packages/api-types
git commit -m "Add monorepo scaffold and shared API types"
```

---

### Task 2: Risk metrics in `paryon-decoder`

**Files:**
- Create: `packages/paryon-decoder/package.json`, `tsconfig.json`, `src/metrics.ts`, `src/index.ts`
- Test: `packages/paryon-decoder/test/metrics.test.ts`

**Interfaces:**
- Consumes: `LoanView`, `RiskBand`, `LoanStatus`, `PARYON_APP_URL` from `@redline/api-types`.
- Produces:
  - `interface RawLoan { id: string; status: LoanStatus; debtPusd: number; collateralSats: number; interestRatePct: number; nextInterestRatePct: number; amountBeingRedeemedPusd: number }`
  - `riskBand(distance: number | null): RiskBand`
  - `computeLoanViews(raw: RawLoan[], priceUsd: number): LoanView[]` (needs the whole set for `debtAheadPusd`)
  - constants `LIQUIDATION_CR = 1.1`, `SMALL_LOAN_PUSD = 100`, `DUST_SATS = 1000`

- [ ] **Step 1: Package files**

`packages/paryon-decoder/package.json`:
```json
{
  "name": "@redline/paryon-decoder",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p .", "test": "vitest run" },
  "dependencies": { "@redline/api-types": "workspace:*" }
}
```
`tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }`

- [ ] **Step 2: Write the failing test** — `test/metrics.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { computeLoanViews, riskBand, type RawLoan } from "../src/index.js";

const base: RawLoan = {
  id: "aa",
  status: "mature",
  debtPusd: 1000,
  collateralSats: 2_00000000, // 2 BCH
  interestRatePct: 1,
  nextInterestRatePct: 1,
  amountBeingRedeemedPusd: 0,
};

describe("riskBand", () => {
  it("maps distance to bands", () => {
    expect(riskBand(0.3)).toBe("safe");
    expect(riskBand(0.25)).toBe("safe");
    expect(riskBand(0.2)).toBe("watch");
    expect(riskBand(0.1)).toBe("danger");
    expect(riskBand(0.05)).toBe("critical");
    expect(riskBand(-0.01)).toBe("critical");
    expect(riskBand(null)).toBe("safe");
  });
});

describe("computeLoanViews", () => {
  it("computes CR, liquidation price and distance", () => {
    // 2 BCH × $700 = $1400 collateral, $1000 debt → CR 140%
    const [v] = computeLoanViews([base], 700);
    expect(v!.collateralBch).toBe(2);
    expect(v!.collateralRatioPct).toBeCloseTo(140, 6);
    expect(v!.liquidationPriceUsd).toBeCloseTo(550, 6); // 1000/2*1.1
    expect(v!.distanceToLiquidation).toBeCloseTo(1 - 550 / 700, 6);
    expect(v!.risk).toBe("watch"); // distance 0.214
  });

  it("sums debt ahead from lower-rate loans and small loans, excluding self", () => {
    const loans: RawLoan[] = [
      { ...base, id: "me", interestRatePct: 2, debtPusd: 1000 },
      { ...base, id: "low", interestRatePct: 1, debtPusd: 500 },
      { ...base, id: "high", interestRatePct: 3, debtPusd: 700 },
      { ...base, id: "small", interestRatePct: 5, debtPusd: 50 },
    ];
    const me = computeLoanViews(loans, 700).find((l) => l.id === "me")!;
    expect(me.debtAheadPusd).toBe(550);
  });

  it("flags stranded, redeeming and pending rate change", () => {
    const loans: RawLoan[] = [
      { ...base, id: "s", debtPusd: 0, collateralSats: 5_000_000 },
      { ...base, id: "r", amountBeingRedeemedPusd: 200, nextInterestRatePct: 2 },
    ];
    const [s, r] = computeLoanViews(loans, 700);
    expect(s!.stranded).toBe(true);
    expect(s!.collateralRatioPct).toBeNull();
    expect(s!.liquidationPriceUsd).toBeNull();
    expect(s!.distanceToLiquidation).toBeNull();
    expect(r!.redemptionInProgress).toBe(true);
    expect(r!.pendingRateChange).toBe(true);
    expect(r!.stranded).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @redline/paryon-decoder test`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 4: Implement** — `src/metrics.ts`

```ts
import {
  PARYON_APP_URL,
  type LoanStatus,
  type LoanView,
  type RiskBand,
} from "@redline/api-types";

export const LIQUIDATION_CR = 1.1;
export const SMALL_LOAN_PUSD = 100;
export const DUST_SATS = 1000;

export interface RawLoan {
  id: string;
  status: LoanStatus;
  debtPusd: number;
  collateralSats: number;
  interestRatePct: number;
  nextInterestRatePct: number;
  amountBeingRedeemedPusd: number;
}

export function riskBand(distance: number | null): RiskBand {
  if (distance === null) return "safe";
  if (distance >= 0.25) return "safe";
  if (distance >= 0.15) return "watch";
  if (distance >= 0.08) return "danger";
  return "critical";
}

function debtAhead(me: RawLoan, all: RawLoan[]): number {
  let sum = 0;
  for (const l of all) {
    if (l.id === me.id || l.debtPusd <= 0) continue;
    if (l.interestRatePct < me.interestRatePct || l.debtPusd < SMALL_LOAN_PUSD) {
      sum += l.debtPusd;
    }
  }
  return Math.round(sum * 100) / 100;
}

export function computeLoanViews(raw: RawLoan[], priceUsd: number): LoanView[] {
  return raw.map((l) => {
    const collateralBch = l.collateralSats / 1e8;
    const hasDebt = l.debtPusd > 0;
    const crPct = hasDebt ? ((collateralBch * priceUsd) / l.debtPusd) * 100 : null;
    const liq = hasDebt ? (l.debtPusd / collateralBch) * LIQUIDATION_CR : null;
    const distance = liq === null ? null : (priceUsd - liq) / priceUsd;
    return {
      id: l.id,
      status: l.status,
      debtPusd: l.debtPusd,
      collateralSats: l.collateralSats,
      collateralBch,
      interestRatePct: l.interestRatePct,
      nextInterestRatePct: l.nextInterestRatePct,
      pendingRateChange: l.nextInterestRatePct !== l.interestRatePct,
      collateralRatioPct: crPct,
      liquidationPriceUsd: liq,
      distanceToLiquidation: distance,
      risk: riskBand(distance),
      debtAheadPusd: debtAhead(l, raw),
      redemptionInProgress: l.amountBeingRedeemedPusd > 0,
      amountBeingRedeemedPusd: l.amountBeingRedeemedPusd,
      stranded: !hasDebt && l.collateralSats > DUST_SATS,
      paryonUrl: PARYON_APP_URL,
    };
  });
}
```

`src/index.ts`:
```ts
export * from "./metrics.js";
```

(vitest and typescript come from the root `devDependencies`.)

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm install && pnpm --filter @redline/paryon-decoder test && pnpm --filter @redline/paryon-decoder typecheck`
Expected: 4 tests PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/paryon-decoder pnpm-lock.yaml
git commit -m "Add loan risk metrics (CR, liquidation price, debt ahead)"
```

---

### Task 3: Mock API server

**Files:**
- Create: `apps/mock-api/package.json`, `tsconfig.json`, `src/fixtures.ts`, `src/state.ts`, `src/app.ts`, `src/main.ts`
- Test: `apps/mock-api/test/app.test.ts`

**Interfaces:**
- Consumes: all types from `@redline/api-types`; `computeLoanViews`, `RawLoan` from `@redline/paryon-decoder`.
- Produces: `createApp(): Hono` (fresh in-memory state per call), `makeRawLoans(seed?: number): RawLoan[]`, `MOCK_PRICE_USD`, `MOCK_BLOCK_HEIGHT`. Server on `PORT` (default 8787).

Mock behaviour (frontend relies on this):
- `POST /api/auth/verify` accepts **any** non-empty `signedTxHex` and sets cookie `rl_session=mock-session` (HttpOnly, SameSite=Lax, Path=/). Other `/api/me*`, `/api/watches*`, `/api/telegram/*`, `/api/invoices*` need that cookie → else 401 `{error:{code:"unauthorized"}}`.
- `GET /api/me/loans` returns the first 3 fixture loans (one critical, one watch, one stranded — fixtures guarantee indices 0–2 have those).
- Watches: free limit 1 → 2nd POST returns 403 code `watch_limit`; after an invoice is paid, limit is `null`.
- `POST /api/invoices/:id/submit` marks the invoice paid, sets `txid` to sha-like fake hex, account `pro=true`, `proUntil = now + 30 days`. Calling it again returns the same paid invoice (idempotent).
- `POST /api/telegram/link-token` → `url: https://t.me/RedlineMockBot?start=<token>`; `GET /api/mock/telegram-linked` (mock-only) flips `telegramLinked=true` so the UI's linked state can be tested.
- `GET /api/utxos` returns two fake pure-BCH UTXOs for the first address.
- `GET /api/health` → `{ ok: true }`.

- [ ] **Step 1: Package files**

`apps/mock-api/package.json`:
```json
{
  "name": "@redline/mock-api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "start": "tsx src/main.ts",
    "typecheck": "tsc -p .",
    "test": "vitest run"
  },
  "dependencies": {
    "@hono/node-server": "2.1.11",
    "@redline/api-types": "workspace:*",
    "@redline/paryon-decoder": "workspace:*",
    "hono": "4.13.19"
  }
}
```
`tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }`

- [ ] **Step 2: Write the failing test** — `test/app.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { Invoice, LoansResponse, LoanView, MeResponse, Watch } from "@redline/api-types";
import { createApp } from "../src/app.js";

async function signIn(app: ReturnType<typeof createApp>) {
  const res = await app.request("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedTxHex: "00" }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) },
    });
}

describe("mock api", () => {
  it("serves realistic loans with every risk band", async () => {
    const app = createApp();
    const body = (await (await app.request("/api/loans")).json()) as LoansResponse;
    expect(body.loans.length).toBe(40);
    const bands = new Set(body.loans.map((l) => l.risk));
    expect([...bands].sort()).toEqual(["critical", "danger", "safe", "watch"]);
    expect(body.loans.some((l) => l.stranded)).toBe(true);
    expect(body.loans.some((l) => l.redemptionInProgress)).toBe(true);
    expect(body.summary.within20pct).toBe(
      body.loans.filter((l) => l.distanceToLiquidation !== null && l.distanceToLiquidation < 0.2).length,
    );
  });

  it("returns one loan or 404", async () => {
    const app = createApp();
    const { loans } = (await (await app.request("/api/loans")).json()) as LoansResponse;
    const one = (await (await app.request(`/api/loans/${loans[5]!.id}`)).json()) as LoanView;
    expect(one.id).toBe(loans[5]!.id);
    expect((await app.request("/api/loans/nope")).status).toBe(404);
  });

  it("requires sign-in for /me", async () => {
    const app = createApp();
    expect((await app.request("/api/me")).status).toBe(401);
    const call = await signIn(app);
    const me = (await (await call("/api/me")).json()) as MeResponse;
    expect(me.pro).toBe(false);
    expect(me.watchLimit).toBe(1);
    const mine = (await (await call("/api/me/loans")).json()) as LoanView[];
    expect(mine.map((l) => l.risk).slice(0, 2)).toEqual(["critical", "watch"]);
    expect(mine[2]!.stranded).toBe(true);
  });

  it("enforces the free watch limit until Pro is paid", async () => {
    const app = createApp();
    const call = await signIn(app);
    const { loans } = (await (await app.request("/api/loans")).json()) as LoansResponse;
    const w1 = await call("/api/watches", { method: "POST", body: JSON.stringify({ loanId: loans[0]!.id }) });
    expect(w1.status).toBe(201);
    const w2 = await call("/api/watches", { method: "POST", body: JSON.stringify({ loanId: loans[1]!.id }) });
    expect(w2.status).toBe(403);
    expect(((await w2.json()) as { error: { code: string } }).error.code).toBe("watch_limit");

    const inv = (await (
      await call("/api/invoices", {
        method: "POST",
        body: JSON.stringify({ asset: "BCH", inputs: [{ txid: "ab".repeat(32), vout: 0 }] }),
      })
    ).json()) as Invoice;
    expect(inv.status).toBe("open");
    const paid = (await (
      await call(`/api/invoices/${inv.id}/submit`, { method: "POST", body: JSON.stringify({ signedTxHex: "00" }) })
    ).json()) as Invoice;
    expect(paid.status).toBe("paid");
    const again = (await (
      await call(`/api/invoices/${inv.id}/submit`, { method: "POST", body: JSON.stringify({ signedTxHex: "00" }) })
    ).json()) as Invoice;
    expect(again.txid).toBe(paid.txid);

    const me = (await (await call("/api/me")).json()) as MeResponse;
    expect(me.pro).toBe(true);
    expect(me.watchLimit).toBeNull();
    const w3 = await call("/api/watches", { method: "POST", body: JSON.stringify({ loanId: loans[1]!.id }) });
    expect(w3.status).toBe(201);
  });

  it("updates and deletes watches", async () => {
    const app = createApp();
    const call = await signIn(app);
    const { loans } = (await (await app.request("/api/loans")).json()) as LoansResponse;
    const w = (await (
      await call("/api/watches", { method: "POST", body: JSON.stringify({ loanId: loans[0]!.id }) })
    ).json()) as Watch;
    expect(w.rules).toEqual({ liquidation: true, loanGone: true });
    const p = (await (
      await call(`/api/watches/${w.id}`, { method: "PATCH", body: JSON.stringify({ rules: { loanGone: false } }) })
    ).json()) as Watch;
    expect(p.rules).toEqual({ liquidation: true, loanGone: false });
    expect((await call(`/api/watches/${w.id}`, { method: "DELETE" })).status).toBe(200);
    expect(((await (await call("/api/watches")).json()) as Watch[]).length).toBe(0);
  });

  it("logs out", async () => {
    const app = createApp();
    const call = await signIn(app);
    await call("/api/auth/logout", { method: "POST" });
    expect((await call("/api/me")).status).toBe(401);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm install && pnpm --filter @redline/mock-api test`
Expected: FAIL — cannot resolve `../src/app.js`.

- [ ] **Step 4: Fixtures** — `src/fixtures.ts`

```ts
import type { RawLoan } from "@redline/paryon-decoder";

export const MOCK_PRICE_USD = 210;
export const MOCK_BLOCK_HEIGHT = 951_200;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexId(rand: () => number): string {
  let s = "";
  for (let i = 0; i < 64; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

/** Build a loan whose CR is exactly `crPct` at MOCK_PRICE_USD. */
function loanAtCr(rand: () => number, crPct: number, debtPusd: number, ratePct: number): RawLoan {
  const collateralBch = (debtPusd * crPct) / 100 / MOCK_PRICE_USD;
  return {
    id: hexId(rand),
    status: "mature",
    debtPusd,
    collateralSats: Math.round(collateralBch * 1e8),
    interestRatePct: ratePct,
    nextInterestRatePct: ratePct,
    amountBeingRedeemedPusd: 0,
  };
}

/**
 * 40 deterministic loans. Indices 0–2 are "my loans" in the mock:
 * 0 = critical (CR 115%), 1 = watch (CR 135%), 2 = stranded (debt 0).
 */
export function makeRawLoans(seed = 42): RawLoan[] {
  const rand = mulberry32(seed);
  const loans: RawLoan[] = [
    loanAtCr(rand, 115, 2_400, 0.5),
    loanAtCr(rand, 135, 850, 1.0),
    { ...loanAtCr(rand, 200, 1, 2.0), debtPusd: 0, collateralSats: 3_120_000 },
    loanAtCr(rand, 126, 5_200, 0.25), // danger
    { ...loanAtCr(rand, 150, 1_300, 0.75), amountBeingRedeemedPusd: 420 },
    { ...loanAtCr(rand, 180, 9_000, 1.5), nextInterestRatePct: 2.5, status: "single-period" },
    { ...loanAtCr(rand, 400, 60, 4.0), status: "new" }, // small loan (< 100 PUSD)
  ];
  while (loans.length < 40) {
    const cr = 120 + Math.floor(rand() * 260); // 120–379%
    const debt = Math.round((200 + rand() * 20_000) * 100) / 100;
    const rate = Math.round(rand() * 60) * 0.05 + 0.05; // 0.05–3.05% in 0.05 steps
    loans.push(loanAtCr(rand, cr, debt, Math.round(rate * 100) / 100));
  }
  return loans;
}
```

- [ ] **Step 5: State** — `src/state.ts`

```ts
import type { Invoice, MeResponse, Watch } from "@redline/api-types";
import { FREE_WATCH_LIMIT } from "@redline/api-types";

export const SESSION_COOKIE = "rl_session";
export const SESSION_VALUE = "mock-session";

export interface MockState {
  signedIn: boolean;
  proUntil: Date | null;
  telegramLinked: boolean;
  watches: Watch[];
  invoices: Map<string, Invoice>;
  nextId: number;
}

export function newState(): MockState {
  return { signedIn: false, proUntil: null, telegramLinked: false, watches: [], invoices: new Map(), nextId: 1 };
}

export function me(s: MockState): MeResponse {
  const pro = s.proUntil !== null && s.proUntil.getTime() > Date.now();
  return {
    accountId: "5e1f".padEnd(64, "0"),
    pro,
    proUntil: s.proUntil?.toISOString() ?? null,
    telegramLinked: s.telegramLinked,
    watchLimit: pro ? null : FREE_WATCH_LIMIT,
  };
}
```

- [ ] **Step 6: App** — `src/app.ts`

```ts
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type {
  ApiError,
  ChallengeResponse,
  CreateInvoiceRequest,
  CreateWatchRequest,
  Invoice,
  LoansResponse,
  TelegramLinkResponse,
  UpdateWatchRequest,
  Utxo,
  Watch,
} from "@redline/api-types";
import { computeLoanViews } from "@redline/paryon-decoder";
import { MOCK_BLOCK_HEIGHT, MOCK_PRICE_USD, makeRawLoans } from "./fixtures.js";
import { SESSION_COOKIE, SESSION_VALUE, me, newState } from "./state.js";

const err = (code: string, message: string): ApiError => ({ error: { code, message } });
const randHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const toHex = (s: string) => Buffer.from(s, "utf8").toString("hex");

export function createApp() {
  const state = newState();
  const loans = computeLoanViews(makeRawLoans(), MOCK_PRICE_USD);
  const app = new Hono().basePath("/api");

  const authed = (c: Context) => state.signedIn && getCookie(c, SESSION_COOKIE) === SESSION_VALUE;

  app.use("*", async (c, next) => {
    const p = c.req.path;
    const open = p === "/api/health" || p.startsWith("/api/loans") || p.startsWith("/api/auth") || p === "/api/utxos";
    if (!open && !authed(c)) return c.json(err("unauthorized", "Sign in first"), 401);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // ---- loans
  app.get("/loans", (c) => {
    const body: LoansResponse = {
      blockHeight: MOCK_BLOCK_HEIGHT,
      priceUsd: MOCK_PRICE_USD,
      updatedAt: new Date().toISOString(),
      summary: {
        total: loans.length,
        within20pct: loans.filter((l) => l.distanceToLiquidation !== null && l.distanceToLiquidation < 0.2).length,
        totalCollateralBch: loans.reduce((a, l) => a + l.collateralBch, 0),
        totalDebtPusd: loans.reduce((a, l) => a + l.debtPusd, 0),
      },
      loans,
    };
    return c.json(body);
  });
  app.get("/loans/:id", (c) => {
    const l = loans.find((x) => x.id === c.req.param("id"));
    return l ? c.json(l) : c.json(err("not_found", "No such loan"), 404);
  });

  // ---- auth
  app.post("/auth/challenge", (c) => {
    const body: ChallengeResponse = {
      nonce: randHex(16),
      expiry: Math.floor(Date.now() / 1000) + 300,
      domain: "localhost",
    };
    return c.json(body);
  });
  app.post("/auth/verify", async (c) => {
    const { signedTxHex } = await c.req.json<{ signedTxHex?: string }>();
    if (!signedTxHex) return c.json(err("bad_request", "signedTxHex required"), 400);
    state.signedIn = true;
    setCookie(c, SESSION_COOKIE, SESSION_VALUE, { httpOnly: true, sameSite: "Lax", path: "/" });
    return c.json(me(state));
  });
  app.post("/auth/logout", (c) => {
    state.signedIn = false;
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
  app.get("/utxos", (c) => {
    const first = (c.req.query("addresses") ?? "").split(",")[0] ?? "";
    const utxos: Utxo[] = [
      { txid: "11".repeat(32), vout: 0, address: first, satoshis: 5_000, height: MOCK_BLOCK_HEIGHT - 3, token: null },
      { txid: "22".repeat(32), vout: 1, address: first, satoshis: 120_000, height: MOCK_BLOCK_HEIGHT - 10, token: null },
    ];
    return c.json(utxos);
  });

  // ---- me
  app.get("/me", (c) => c.json(me(state)));
  app.get("/me/loans", (c) => c.json(loans.slice(0, 3)));

  // ---- watches
  app.get("/watches", (c) => c.json(state.watches));
  app.post("/watches", async (c) => {
    const body = await c.req.json<CreateWatchRequest>();
    if (!loans.some((l) => l.id === body.loanId)) return c.json(err("not_found", "No such loan"), 404);
    const limit = me(state).watchLimit;
    if (limit !== null && state.watches.length >= limit)
      return c.json(err("watch_limit", "Free plan allows 1 watch. Get the 30-day Pro pass for more."), 403);
    const w: Watch = {
      id: String(state.nextId++),
      loanId: body.loanId,
      rules: { liquidation: true, loanGone: true, ...body.rules },
      lastBand: null,
      createdAt: new Date().toISOString(),
    };
    state.watches.push(w);
    return c.json(w, 201);
  });
  app.patch("/watches/:id", async (c) => {
    const w = state.watches.find((x) => x.id === c.req.param("id"));
    if (!w) return c.json(err("not_found", "No such watch"), 404);
    const body = await c.req.json<UpdateWatchRequest>();
    w.rules = { ...w.rules, ...body.rules };
    return c.json(w);
  });
  app.delete("/watches/:id", (c) => {
    const before = state.watches.length;
    state.watches = state.watches.filter((x) => x.id !== c.req.param("id"));
    return before === state.watches.length ? c.json(err("not_found", "No such watch"), 404) : c.json({ ok: true });
  });

  // ---- telegram
  app.post("/telegram/link-token", (c) => {
    const token = randHex(8);
    const body: TelegramLinkResponse = {
      token,
      url: `https://t.me/RedlineMockBot?start=${token}`,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    return c.json(body);
  });
  app.get("/mock/telegram-linked", (c) => {
    state.telegramLinked = true;
    return c.json(me(state));
  });

  // ---- invoices
  app.post("/invoices", async (c) => {
    const body = await c.req.json<CreateInvoiceRequest>();
    const id = randHex(8);
    const inv: Invoice = {
      id,
      status: "open",
      asset: "BCH",
      amountSats: Math.round((0.25 / MOCK_PRICE_USD) * 1e8),
      merchantAddress: "bitcoincash:zmockmerchantaddressxxxxxxxxxxxxxxxxxxxxxxx",
      opReturnHex: toHex("PWINV") + id,
      inputs: body.inputs,
      txid: null,
      createdAt: new Date().toISOString(),
      paidAt: null,
    };
    state.invoices.set(id, inv);
    return c.json(inv, 201);
  });
  app.get("/invoices/:id", (c) => {
    const inv = state.invoices.get(c.req.param("id"));
    return inv ? c.json(inv) : c.json(err("not_found", "No such invoice"), 404);
  });
  app.post("/invoices/:id/submit", (c) => {
    const inv = state.invoices.get(c.req.param("id"));
    if (!inv) return c.json(err("not_found", "No such invoice"), 404);
    if (inv.status !== "paid") {
      inv.status = "paid";
      inv.txid = randHex(32);
      inv.paidAt = new Date().toISOString();
      state.proUntil = new Date(Date.now() + 30 * 86_400_000);
    }
    return c.json(inv);
  });

  return app;
}
```

- [ ] **Step 7: Entry point** — `src/main.ts`

```ts
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp().fetch, port }, () => {
  console.log(`Redline mock API on http://localhost:${port}/api`);
});
```

- [ ] **Step 8: Run tests, typecheck, and smoke-run**

Run: `pnpm --filter @redline/mock-api test && pnpm -r typecheck`
Expected: 6 tests PASS; typecheck exits 0.

Run (background): `pnpm dev:mock`, then `curl -s localhost:8787/api/loans | head -c 300`
Expected: JSON starting `{"blockHeight":951200,"priceUsd":210,...`. Stop the server.

If the fixture band test fails (a band missing), adjust only the CRs of fixed fixtures 0–6 — they already cover critical (115%), watch (135%), danger (126%) and safe (180%).

- [ ] **Step 9: Commit**

```bash
git add apps/mock-api pnpm-lock.yaml
git commit -m "Add mock API server with realistic loan fixtures"
```

---

### Task 4: API docs for the front end + push

**Files:**
- Create: `docs/API.md`

- [ ] **Step 1: Write `docs/API.md`**

````markdown
# Redline API (for the front end)

Types: `packages/api-types/src/index.ts` — import with `import type { … } from "@redline/api-types"`.
All routes are under `/api`. Always call relative URLs (`fetch("/api/loans", { credentials: "include" })`).

## Run the mock

```bash
pnpm install
pnpm dev:mock          # http://localhost:8787/api
```

Vite proxy (`apps/web/vite.config.ts`):
```ts
server: { proxy: { "/api": "http://localhost:8787" } }
```
Production: Vercel rewrites `/api/:path*` to the Railway server, so cookies stay same-origin.

## Endpoints

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | /api/health | – | `{ ok: true }` |
| GET | /api/loans | – | `LoansResponse` |
| GET | /api/loans/:id | – | `LoanView` / 404 |
| POST | /api/auth/challenge | – | `ChallengeResponse` |
| POST | /api/auth/verify | – | `MeResponse` + session cookie |
| POST | /api/auth/logout | – | `{ ok: true }` |
| GET | /api/utxos?addresses=a,b | – | `Utxo[]` |
| GET | /api/me | ✓ | `MeResponse` |
| GET | /api/me/loans | ✓ | `LoanView[]` |
| GET/POST | /api/watches | ✓ | `Watch[]` / `Watch` (201) — 403 `watch_limit` on free plan |
| PATCH/DELETE | /api/watches/:id | ✓ | `Watch` / `{ ok: true }` |
| POST | /api/telegram/link-token | ✓ | `TelegramLinkResponse` |
| POST | /api/invoices | ✓ | `Invoice` (201) |
| GET | /api/invoices/:id | ✓ | `Invoice` |
| POST | /api/invoices/:id/submit | ✓ | `Invoice` |

Errors are always `{ "error": { "code": "...", "message": "..." } }` (401 `unauthorized`, 403 `watch_limit`, 404 `not_found`).

## Mock-only behaviour

- `POST /api/auth/verify` with any `{ "signedTxHex": "00" }` signs you in — no wallet needed.
- `GET /api/me/loans` returns 3 loans: critical, watch, stranded.
- Submitting an invoice marks it paid and turns on Pro (watch limit becomes unlimited).
- `GET /api/mock/telegram-linked` marks Telegram as connected.
- State resets when the mock restarts.

## Real sign-in (later)

The Sign in screen will call `wizardLogin({ manager, apiBase: "/api", domain })` from `packages/wizard-login`; it returns a `MeResponse`. Until then, use the mock shortcut above.
````

- [ ] **Step 2: Commit and push**

```bash
git add docs/API.md
git commit -m "Document the API and mock for the front end"
git push
```

- [ ] **Step 3: Update PROGRESS.md** — tick the G-API row (✅) and the Fri "monorepo scaffold" line, commit, push. Tell jadonamite: pull `main`, read `docs/API.md`.
