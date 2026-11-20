import { binToHex, utf8ToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import {
  INVOICE_OP_RETURN_BYTES,
  MAX_INVOICE_INPUTS,
  decodeInvoiceOpReturn,
  encodeInvoiceOpReturn,
  estimatePaymentFee,
  invoiceOpReturnHex,
  proPassSats,
} from "../src/index.js";

const ID = "00112233445566778899aabbccddeeff";

describe("invoice OP_RETURN", () => {
  it("is 0x6a + push 'PWINV' + push of the 16 id bytes", () => {
    const b = encodeInvoiceOpReturn(ID);
    expect(binToHex(b)).toBe("6a" + "05" + binToHex(utf8ToBin("PWINV")) + "10" + ID);
    expect(b.length).toBe(INVOICE_OP_RETURN_BYTES);
    // the API's opReturnHex is the payload after OP_RETURN
    expect(invoiceOpReturnHex(ID)).toBe(binToHex(b).slice(2));
  });

  it("round trips and rejects anything else", () => {
    const good = encodeInvoiceOpReturn(ID);
    expect(decodeInvoiceOpReturn(good)).toBe(ID);
    expect(decodeInvoiceOpReturn(good.slice(1))).toBeNull();
    expect(decodeInvoiceOpReturn(good.slice(0, -1))).toBeNull();
    expect(decodeInvoiceOpReturn(Uint8Array.of(...good, 0x51))).toBeNull();
    const magic = Uint8Array.from(good);
    magic[2] = 0x51; // "QWINV"
    expect(decodeInvoiceOpReturn(magic)).toBeNull();
    // non-minimal push of the magic (OP_PUSHDATA1 05 …)
    expect(decodeInvoiceOpReturn(Uint8Array.of(0x6a, 0x4c, 0x05, ...utf8ToBin("PWINV"), 0x10, ...good.slice(-16)))).toBeNull();
  });

  it("encode refuses a malformed id", () => {
    expect(() => encodeInvoiceOpReturn("abcd")).toThrow();
    expect(() => encodeInvoiceOpReturn(ID.toUpperCase())).toThrow();
  });
});

describe("payment fee + price", () => {
  it("fee = 1 sat/byte estimate, at least 300", () => {
    expect(estimatePaymentFee(1)).toBe(300); // 10 + 148 + 68 + 33 = 259 → floor 300
    expect(estimatePaymentFee(2)).toBe(10 + 148 * 2 + 68 + 33);
    expect(estimatePaymentFee(MAX_INVOICE_INPUTS)).toBe(10 + 148 * 10 + 68 + 33);
  });

  it("proPassSats = ceil(0.25 / price × 1e8)", () => {
    expect(proPassSats(400)).toBe(62_500);
    expect(proPassSats(300)).toBe(83_334); // 83333.33… → up
    expect(proPassSats(250)).toBe(100_000);
    expect(() => proPassSats(0)).toThrow();
    expect(() => proPassSats(Number.NaN)).toThrow();
  });
});
