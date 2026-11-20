import type { LoanStatus } from "@redline/api-types";

export interface DecodedLoanState {
  borrowedCents: number;
  redeemingCents: number;
  status: LoanStatus;
  lastPeriodInterestPaid: number;
  currentRateRaw: number;
  nextRateRaw: number;
  interestManager: number;
  minRateManager: number;
  maxRateManager: number;
}

function le(bytes: Uint8Array, offset: number, size: number): number {
  let v = 0n;
  for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]!);
  return Number(v);
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  return Uint8Array.from((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
}

const STATUSES: LoanStatus[] = ["new", "single-period", "mature"];

export function decodeLoanCommitment(hex: string): DecodedLoanState | null {
  if (hex.length !== 54) return null;
  const b = fromHex(hex);
  if (!b || b[0] !== 0x01) return null;
  const status = STATUSES[b[13]!];
  if (!status) return null;
  return {
    borrowedCents: le(b, 1, 6),
    redeemingCents: le(b, 7, 6),
    status,
    lastPeriodInterestPaid: le(b, 14, 4),
    currentRateRaw: le(b, 18, 2),
    nextRateRaw: le(b, 20, 2),
    interestManager: b[22]!,
    minRateManager: le(b, 23, 2),
    maxRateManager: le(b, 25, 2),
  };
}

/** Raw unit is per 10,000,000 per 144-block period; returns annual % rounded to 2 dp. */
export function rawRateToAnnualPct(raw: number): number {
  return Math.round((raw * 365) / 1000) / 100;
}

export function decodePriceCommitment(hex: string): { sequence: number; priceUsd: number } | null {
  if (hex.length !== 18) return null;
  const b = fromHex(hex);
  if (!b || b[0] !== 0x00) return null;
  return { sequence: le(b, 1, 4), priceUsd: le(b, 5, 4) / 100 };
}
