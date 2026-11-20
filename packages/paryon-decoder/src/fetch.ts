import { ElectrumNetworkProvider } from "cashscript";
import { PARYON_ADDRESSES } from "./addresses.js";
import { buildSnapshot, type ChainUtxo, type Snapshot } from "./snapshot.js";

export async function fetchSnapshot(opts: { hostname?: string } = {}): Promise<Snapshot> {
  const provider = new ElectrumNetworkProvider(
    "mainnet",
    opts.hostname ? { hostname: opts.hostname, manualConnectionManagement: true } : { manualConnectionManagement: true },
  );
  try {
    await provider.connect();
    const get = async (address: string): Promise<ChainUtxo[]> =>
      (await provider.getUtxos(address)).map((u) => ({
        txid: u.txid,
        vout: u.vout,
        satoshis: Number(u.satoshis),
        ...(u.token && {
          token: {
            category: u.token.category,
            amount: u.token.amount.toString(),
            ...(u.token.nft && { nft: { capability: u.token.nft.capability, commitment: u.token.nft.commitment } }),
          },
        }),
      }));
    const [loanUtxos, sidecarUtxos, priceUtxos, blockHeight] = await Promise.all([
      get(PARYON_ADDRESSES.loan),
      get(PARYON_ADDRESSES.loanSidecar),
      get(PARYON_ADDRESSES.price),
      provider.getBlockHeight(),
    ]);
    return buildSnapshot({ loanUtxos, sidecarUtxos, priceUtxos, blockHeight });
  } finally {
    try {
      await provider.disconnect();
    } catch {
      // never mask the original error
    }
  }
}
