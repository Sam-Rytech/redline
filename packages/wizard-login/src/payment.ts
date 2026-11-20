// 30-day Pro pass payment (BCH): invoice OP_RETURN format, fee estimate and price math.
// Shared by the client (payProPass) and the server (invoice routes). See docs/API.md.
import { binToHex, binToUtf8, binsAreEqual, decodeAuthenticationInstructions, encodeDataPush, flattenBinArray, hexToBin, utf8ToBin } from "@bitauth/libauth";
import { PRO_PASS_USD } from "@redline/api-types";

export const INVOICE_MAGIC = "PWINV";
export const INVOICE_ID_BYTES = 16;
/** an invoice holds 1..10 inputs */
export const MAX_INVOICE_INPUTS = 10;
/** the server wants inputs worth at least amountSats + this */
export const PAYMENT_FEE_HEADROOM_SATS = 500;
export const MIN_PAYMENT_FEE_SATS = 300;
/** change below this is dropped into the fee */
export const DUST_SATS = 546;
/** OP_RETURN locking bytecode length: 6a 05 "PWINV" 10 <16 bytes> */
export const INVOICE_OP_RETURN_BYTES = 1 + 1 + INVOICE_MAGIC.length + 1 + INVOICE_ID_BYTES;

const OP_RETURN = 0x6a;
const HEX_ID = /^[0-9a-f]{32}$/;

/** The invoice's OP_RETURN output locking bytecode (0x6a + push "PWINV" + push of the 16 id bytes). */
export function encodeInvoiceOpReturn(idHex: string): Uint8Array {
  if (!HEX_ID.test(idHex)) throw new Error("invoice id must be 16 bytes of lowercase hex");
  return flattenBinArray([Uint8Array.of(OP_RETURN), encodeDataPush(utf8ToBin(INVOICE_MAGIC)), encodeDataPush(hexToBin(idHex))]);
}

/** `Invoice.opReturnHex`: the OP_RETURN payload (the two pushes, without the 0x6a opcode). */
export const invoiceOpReturnHex = (idHex: string): string => binToHex(encodeInvoiceOpReturn(idHex).slice(1));

/** Strict decode: the invoice id, or null unless the bytecode is exactly what encodeInvoiceOpReturn makes. */
export function decodeInvoiceOpReturn(lockingBytecode: Uint8Array): string | null {
  if (lockingBytecode.length !== INVOICE_OP_RETURN_BYTES || lockingBytecode[0] !== OP_RETURN) return null;
  const ins = decodeAuthenticationInstructions(lockingBytecode.slice(1));
  if (ins.length !== 2) return null;
  const data: Uint8Array[] = [];
  for (const i of ins) {
    if (("malformed" in i && i.malformed) || !("data" in i)) return null;
    data.push(i.data);
  }
  const [magic, id] = data as [Uint8Array, Uint8Array];
  if (binToUtf8(magic) !== INVOICE_MAGIC || id.length !== INVOICE_ID_BYTES) return null;
  const idHex = binToHex(id);
  return binsAreEqual(encodeInvoiceOpReturn(idHex), lockingBytecode) ? idHex : null;
}

/** 1 sat/byte estimate for `inputs` P2PKH inputs + 2 P2PKH outputs + the invoice OP_RETURN, at least 300. */
export function estimatePaymentFee(inputs: number): number {
  const opReturnOutput = 8 + 1 + INVOICE_OP_RETURN_BYTES;
  return Math.max(MIN_PAYMENT_FEE_SATS, 10 + 148 * inputs + 34 * 2 + opReturnOutput);
}

/** Pro pass price in sats at `priceUsd` USD/BCH, rounded up. */
export function proPassSats(priceUsd: number): number {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error("priceUsd must be a positive number");
  // 0.25 × 1e8 is exact, so the only rounding is the division
  return Math.ceil((PRO_PASS_USD * 1e8) / priceUsd);
}
