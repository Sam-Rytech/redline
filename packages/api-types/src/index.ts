// Redline API contract. Every route is under API_PREFIX.
// Changing anything here = tell the other side in the team chat.

export const API_PREFIX = "/api";
export const FREE_WATCH_LIMIT = 1;
/**
 * Official Paryon dApp; alerts and loan cards link here. This is the "Go to dApp" link on
 * stats.paryonusd.com (checked 20 Nov 2026; app.paryonusd.com returns 404). The dApp has no
 * per-loan URLs, so every link goes to the app itself.
 */
export const PARYON_APP_URL = "https://paryonusd.com/app";

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
  /** All loan outputs, including stranded (debt 0) ones */
  total: number;
  /** Loans with debt > 0: the "N active loans" figure on stats.paryonusd.com */
  activeCount: number;
  /** Collateral of active loans only: the "Total Collateral" figure on stats.paryonusd.com */
  activeCollateralBch: number;
  /** Landing counter: loans with distanceToLiquidation < 0.20 */
  within20pct: number;
  totalCollateralBch: number;
  totalDebtPusd: number;
  /** Loans with debt 0 that still hold collateral (fully redeemed, unclaimed) */
  strandedCount: number;
  strandedBch: number;
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
/** POST /api/watches (403 code "watch_limit" when over FREE_WATCH_LIMIT; 409 code "watch_exists" if the loan is already watched) */
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

export const PRO_PASS_USD = 0.25;
export const PRO_PASS_DAYS = 30;

/** GET /api/invoices/quote (auth required) — call BEFORE choosing inputs */
export interface InvoiceQuote {
  asset: "BCH";
  amountSats: number;
  priceUsd: number;
  merchantAddress: string; // bitcoincash:z…
  validUntil: ISODate;
}

/**
 * POST /api/invoices
 * Flow: quote → pick inputs ≥ amountSats + fee → POST /invoices → sign → submit.
 * `inputs` must be non-empty.
 */
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
