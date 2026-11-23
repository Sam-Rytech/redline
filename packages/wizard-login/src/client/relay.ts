// Sign requests travel over the WizardConnect relay as JSON, which cannot hold BigInt or
// Uint8Array. The protocol's own encoding (@wizardconnect/core/hdwalletv1-serialize): the
// transaction as hex, and each source output with hex bytes and `<bigint: Xn>` amounts.
import { encodeTransaction, binToHex, type Input, type Output, type TransactionCommon } from "@bitauth/libauth";
import { sourceOutputToRelay } from "@wizardconnect/core/hdwalletv1-serialize";
import type { DappConnectionManager } from "@wizardconnect/dapp";

type WcRequest = Parameters<DappConnectionManager["signTransaction"]>[0]["transaction"];

export function relaySignRequest(o: {
  transaction: TransactionCommon;
  sourceOutputs: Array<Input & Output>;
  broadcast: boolean;
  userPrompt: string;
}): WcRequest {
  const request = {
    transaction: binToHex(encodeTransaction(o.transaction)),
    sourceOutputs: o.sourceOutputs.map((so) => sourceOutputToRelay(so)),
    broadcast: o.broadcast,
    userPrompt: o.userPrompt,
  };
  // fail here, with a clear message, rather than deep inside the relay
  JSON.stringify(request);
  return request as unknown as WcRequest;
}
