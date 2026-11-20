import { Contract, ElectrumNetworkProvider } from "cashscript";
import { paryonArtifacts } from "@paryonusd/contracts";
import { MAINNET_V1 } from "./deployment.js";

export function reverseHex(hex: string): string {
  return (hex.match(/../g) ?? []).reverse().join("");
}

// cashscript's Contract constructor requires a provider object (no provider-free option in 0.14.0).
// The provider connects lazily, and we only build it on first access, so importing has no side effect.
function computeAddresses() {
  const options = { provider: new ElectrumNetworkProvider("mainnet"), contractType: "p2sh32" } as const;
  return {
    loan: new Contract(paryonArtifacts.artifactLoan, [], options).address,
    loanSidecar: new Contract(paryonArtifacts.artifactLoanSidecar, [], options).address,
    price: new Contract(
      paryonArtifacts.artifactPriceContractGuarded,
      [MAINNET_V1.oraclePublicKey, reverseHex(MAINNET_V1.oracleMigrationKeyTokenId)],
      options,
    ).address,
  };
}

let cached: ReturnType<typeof computeAddresses> | undefined;
const addrs = () => (cached ??= computeAddresses());

export const PARYON_ADDRESSES = {
  get loan() {
    return addrs().loan;
  },
  get loanSidecar() {
    return addrs().loanSidecar;
  },
  get price() {
    return addrs().price;
  },
};
