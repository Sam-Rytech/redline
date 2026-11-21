// WizardConnect login transaction format (v1). Shared by the client and server halves.
// See ARCHITECTURE.md §3.1.
import {
  binToHex,
  binToNumberUint32LE,
  binToUtf8,
  binsAreEqual,
  decodeAuthenticationInstructions,
  encodeDataPush,
  flattenBinArray,
  hexToBin,
  numberToBinUint32LE,
  utf8ToBin,
  type TransactionCommon,
} from "@bitauth/libauth";

export const LOGIN_MAGIC = "WZL1";
/** Smallest pure-BCH UTXO the client may pick for the login transaction. */
export const MIN_LOGIN_UTXO_SATS = 2000;
/** Fixed fee the client uses. */
export const LOGIN_FEE_SATS = 400;
/** Fee range the server accepts. */
export const MIN_LOGIN_FEE_SATS = 200;
export const MAX_LOGIN_FEE_SATS = 2000;
export const NONCE_BYTES = 16;

const OP_RETURN = 0x6a;
const HEX_NONCE = /^[0-9a-f]{32}$/;
const TXID = /^[0-9a-f]{64}$/;

export interface LoginOpReturn {
  domain: string;
  nonceHex: string;
  /** unix seconds */
  expiry: number;
}

export function encodeLoginOpReturn({ domain, nonceHex, expiry }: LoginOpReturn): Uint8Array {
  if (typeof domain !== "string" || domain.length === 0) throw new Error("domain must be a non-empty string");
  if (!HEX_NONCE.test(nonceHex)) throw new Error("nonceHex must be 16 bytes of lowercase hex");
  if (!Number.isInteger(expiry) || expiry < 0 || expiry > 0xffffffff) throw new Error("expiry must be a uint32");
  return flattenBinArray([
    Uint8Array.of(OP_RETURN),
    encodeDataPush(utf8ToBin(LOGIN_MAGIC)),
    encodeDataPush(utf8ToBin(domain)),
    encodeDataPush(hexToBin(nonceHex)),
    encodeDataPush(numberToBinUint32LE(expiry)),
  ]);
}

/** Strict decode: returns null unless the bytecode is exactly what encodeLoginOpReturn would produce. */
export function decodeLoginOpReturn(lockingBytecode: Uint8Array): LoginOpReturn | null {
  if (lockingBytecode.length < 2 || lockingBytecode[0] !== OP_RETURN) return null;
  const ins = decodeAuthenticationInstructions(lockingBytecode.slice(1));
  if (ins.length !== 4) return null;
  const data: Uint8Array[] = [];
  for (const i of ins) {
    if ("malformed" in i && i.malformed) return null;
    if (!("data" in i)) return null;
    data.push(i.data);
  }
  const [magic, domainBin, nonce, expiryBin] = data as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  if (binToUtf8(magic) !== LOGIN_MAGIC || nonce.length !== NONCE_BYTES || expiryBin.length !== 4) return null;
  const domain = binToUtf8(domainBin);
  const decoded = { domain, nonceHex: binToHex(nonce), expiry: binToNumberUint32LE(expiryBin) };
  let canonical: Uint8Array;
  try {
    canonical = encodeLoginOpReturn(decoded);
  } catch {
    return null;
  }
  // rejects non-minimal pushes and non-round-tripping utf8
  return binsAreEqual(canonical, lockingBytecode) ? decoded : null;
}

export interface UnsignedLoginTxInput extends LoginOpReturn {
  outpoint: { txid: string; vout: number };
  sourceLockingBytecode: Uint8Array;
  sourceValueSats: bigint | number;
}

/**
 * Build the unsigned login transaction. The source must be a token-free receive-path P2PKH
 * UTXO (the server only accepts proofs of the receive xpub) and input 0 must be signed with
 * SIGHASH_ALL|FORKID (0x41); other sighash types are rejected. libauth 3.0.0 keeps `outpointTransactionHash`
 * in display (big-endian) order and reverses it when encoding, so the txid hex is used as-is.
 */
export function buildUnsignedLoginTx(o: UnsignedLoginTxInput): TransactionCommon {
  if (!TXID.test(o.outpoint.txid)) throw new Error("outpoint.txid must be 32 bytes of lowercase hex");
  if (!Number.isInteger(o.outpoint.vout) || o.outpoint.vout < 0 || o.outpoint.vout > 0xffffffff) {
    throw new Error("outpoint.vout must be a uint32");
  }
  const value = BigInt(o.sourceValueSats);
  if (value < BigInt(MIN_LOGIN_UTXO_SATS)) throw new Error(`login UTXO must hold at least ${MIN_LOGIN_UTXO_SATS} sats`);
  return {
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointTransactionHash: hexToBin(o.outpoint.txid),
        outpointIndex: o.outpoint.vout,
        sequenceNumber: 0xffffffff,
        unlockingBytecode: new Uint8Array(),
      },
    ],
    outputs: [
      { lockingBytecode: encodeLoginOpReturn(o), valueSatoshis: 0n },
      { lockingBytecode: Uint8Array.from(o.sourceLockingBytecode), valueSatoshis: value - BigInt(LOGIN_FEE_SATS) },
    ],
  };
}
