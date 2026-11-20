// Test helper: produces login transactions exactly like a WizardConnect wallet would
// (P2PKH, SIGHASH_ALL | FORKID, Schnorr), from a fixed-seed HD wallet.
import {
  binToHex,
  deriveHdPath,
  deriveHdPrivateNodeChild,
  deriveHdPrivateNodeFromSeed,
  deriveHdPublicNode,
  encodeDataPush,
  encodeHdPublicKey,
  encodeLockingBytecodeP2pkh,
  encodeTransaction,
  flattenBinArray,
  generateSigningSerializationBCH,
  hash160,
  secp256k1,
  sha256,
  type HdPrivateNodeValid,
  type TransactionCommon,
} from "@bitauth/libauth";
import { buildUnsignedLoginTx } from "../src/protocol.js";

const SIGHASH_ALL_FORKID = 0x41;

export interface TestWallet {
  xpubReceive: string;
  xpubChange: string;
  privateKey(path: "receive" | "change", index: number): Uint8Array;
  publicKey(path: "receive" | "change", index: number): Uint8Array;
  lockingBytecode(path: "receive" | "change", index: number): Uint8Array;
}

export function makeWallet(seedByte = 1): TestWallet {
  const master = deriveHdPrivateNodeFromSeed(new Uint8Array(32).fill(seedByte));
  const account = deriveHdPath(master, "m/44'/145'/0'") as HdPrivateNodeValid;
  const chains = { receive: deriveHdPrivateNodeChild(account, 0), change: deriveHdPrivateNodeChild(account, 1) };
  const xpub = (n: HdPrivateNodeValid) => encodeHdPublicKey({ network: "mainnet", node: deriveHdPublicNode(n) }).hdPublicKey;
  const privateKey = (p: "receive" | "change", i: number) => deriveHdPrivateNodeChild(chains[p], i).privateKey;
  const publicKey = (p: "receive" | "change", i: number) => {
    const pk = secp256k1.derivePublicKeyCompressed(privateKey(p, i));
    if (typeof pk === "string") throw new Error(pk);
    return pk;
  };
  return {
    xpubReceive: xpub(chains.receive),
    xpubChange: xpub(chains.change),
    privateKey,
    publicKey,
    lockingBytecode: (p, i) => encodeLockingBytecodeP2pkh(hash160(publicKey(p, i))),
  };
}

/** Sign input 0 (P2PKH) of `tx` in place-free fashion; returns the signed transaction. */
export function signP2pkhInput0(
  tx: TransactionCommon,
  source: { lockingBytecode: Uint8Array; valueSatoshis: bigint },
  privateKey: Uint8Array,
  opts: { sighash?: number; ecdsa?: boolean } = {},
): TransactionCommon {
  const sighash = opts.sighash ?? SIGHASH_ALL_FORKID;
  const pub = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof pub === "string") throw new Error(pub);
  const serialization = generateSigningSerializationBCH(
    { inputIndex: 0, sourceOutputs: [source], transaction: tx },
    { coveredBytecode: source.lockingBytecode, signingSerializationType: Uint8Array.of(sighash) },
  );
  const digest = sha256.hash(sha256.hash(serialization));
  const sig = opts.ecdsa ? secp256k1.signMessageHashDER(privateKey, digest) : secp256k1.signMessageHashSchnorr(privateKey, digest);
  if (typeof sig === "string") throw new Error(sig);
  const unlockingBytecode = flattenBinArray([
    encodeDataPush(flattenBinArray([sig, Uint8Array.of(sighash)])),
    encodeDataPush(pub),
  ]);
  const [input, ...rest] = tx.inputs;
  if (!input) throw new Error("no input 0");
  return { ...tx, inputs: [{ ...input, unlockingBytecode }, ...rest] };
}

export const FUNDING_TXID = "11".repeat(31) + "ab";

export interface LoginTxOptions {
  wallet: TestWallet;
  path?: ["receive" | "change", number];
  outpoint?: { txid: string; vout: number };
  sourceValueSats?: bigint;
  domain: string;
  nonceHex: string;
  expiry: number;
  /** sign with this key instead of the path key */
  signWith?: Uint8Array;
  /** mutate the unsigned tx before signing */
  mutateBeforeSign?: (tx: TransactionCommon) => TransactionCommon;
  /** signature hash type byte (default 0x41 = ALL|FORKID) */
  sighash?: number;
  /** sign with DER ECDSA instead of Schnorr */
  ecdsa?: boolean;
  /** mutate the signed tx (breaks the signature) */
  mutateAfterSign?: (tx: TransactionCommon) => TransactionCommon;
}

export function makeLoginTx(o: LoginTxOptions) {
  const path = o.path ?? ["receive", 0];
  const outpoint = o.outpoint ?? { txid: FUNDING_TXID, vout: 1 };
  const source = { lockingBytecode: o.wallet.lockingBytecode(path[0], path[1]), valueSatoshis: o.sourceValueSats ?? 10_000n };
  let tx = buildUnsignedLoginTx({
    outpoint,
    sourceLockingBytecode: source.lockingBytecode,
    sourceValueSats: source.valueSatoshis,
    domain: o.domain,
    nonceHex: o.nonceHex,
    expiry: o.expiry,
  });
  if (o.mutateBeforeSign) tx = o.mutateBeforeSign(tx);
  let signed = signP2pkhInput0(tx, source, o.signWith ?? o.wallet.privateKey(path[0], path[1]), {
    ...(o.sighash !== undefined && { sighash: o.sighash }),
    ...(o.ecdsa !== undefined && { ecdsa: o.ecdsa }),
  });
  if (o.mutateAfterSign) signed = o.mutateAfterSign(signed);
  return { hex: binToHex(encodeTransaction(signed)), tx: signed, source, outpoint, path };
}
