// What a real wallet receives: the sign request after a JSON round trip through the relay,
// decoded with the protocol's own rules (hex bytes, `<bigint: Xn>` amounts).
import { decodeTransaction, hexToBin, type Input, type Output, type TransactionCommon } from "@bitauth/libauth";
import { toBigInt } from "@wizardconnect/core";

interface RelaySourceOutput {
  outpointTransactionHash: string;
  outpointIndex: number;
  unlockingBytecode: string;
  sequenceNumber: number;
  valueSatoshis: string;
  lockingBytecode: string;
}

export function viaRelay<T>(req: T): T {
  // throws "Do not know how to serialize a BigInt" exactly like the real relay
  return JSON.parse(JSON.stringify(req)) as T;
}

export function decodeRelayRequest(t: { transaction: unknown; sourceOutputs: unknown }): {
  transaction: TransactionCommon;
  sourceOutputs: Array<Input & Output>;
} {
  if (typeof t.transaction !== "string") throw new Error("relay request: transaction must be hex");
  const decoded = decodeTransaction(hexToBin(t.transaction));
  if (typeof decoded === "string") throw new Error(`relay request: ${decoded}`);
  const sourceOutputs = (t.sourceOutputs as RelaySourceOutput[]).map((so) => ({
    outpointTransactionHash: hexToBin(so.outpointTransactionHash),
    outpointIndex: so.outpointIndex,
    unlockingBytecode: hexToBin(so.unlockingBytecode),
    sequenceNumber: so.sequenceNumber,
    valueSatoshis: toBigInt(so.valueSatoshis),
    lockingBytecode: hexToBin(so.lockingBytecode),
  }));
  return { transaction: decoded, sourceOutputs };
}
