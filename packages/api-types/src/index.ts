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
  /** invoiceId: on 409 invoice_open, the open invoice to reuse */
  error: { code: string; message: string; invoiceId?: string };
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
  /** Sign-in must use a receive-path UTXO (index 0..999); anything else → 400 bad_path. */
  path: ["receive", number];
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
  /** band at the last alert evaluation; null before the first one (and after the loan is gone) */
  lastBand: RiskBand | null;
  createdAt: ISODate;
}

/** GET /api/watches → Watch[] */
/**
 * POST /api/watches → Watch (201). 404 "not_found" if the loan is unknown, 503 "not_ready" before chain data,
 * 409 "watch_exists" if the loan is already watched, 403 "watch_limit" when over FREE_WATCH_LIMIT (not Pro).
 * Rules default to { liquidation: true, loanGone: true }.
 */
export interface CreateWatchRequest {
  loanId: Hex;
  rules?: Partial<WatchRules>;
}
/** PATCH /api/watches/:id → Watch (404 if not yours) */
export interface UpdateWatchRequest {
  rules: Partial<WatchRules>;
}
/** DELETE /api/watches/:id → { ok: true } (404 if not yours) */

// ---------- telegram ----------
/**
 * POST /api/telegram/link-token → TelegramLinkResponse. Token is single use, valid 10 minutes.
 * 503 "telegram_unavailable" when the server has no bot configured.
 * POST /api/telegram/unlink → { ok: true } (MeResponse.telegramLinked becomes false).
 */
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
  /**
   * OP_RETURN payload hex after the 0x6a opcode: push "PWINV" + push of the 16 id bytes
   * (05 5057494e56 10 <id>). The output's locking bytecode is "6a" + this.
   */
  opReturnHex: Hex;
  /** Inputs the client must reuse on any retry */
  inputs: Outpoint[];
  txid: Hex | null;
  createdAt: ISODate;
  paidAt: ISODate | null;
  /**
   * Set by GET /api/invoices/:id on an unpaid invoice: true when one of its inputs is spent by a
   * transaction that does not pay it (the invoice can never be paid; start a new one).
   */
  inputsSpent?: boolean;
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
