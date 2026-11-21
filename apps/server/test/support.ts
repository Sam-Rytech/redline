// Shared test wiring: an app with an in-memory database, a fake chain and fixed secrets.
import { createApp, type AppDeps } from "../src/app.js";
import { createSecrets } from "../src/crypto.js";
import { openDatabase } from "../src/db/open.js";
import type { Chain } from "../src/electrum.js";
import type { ChainReader } from "../src/reader.js";

export const TEST_ORIGIN = "https://redline.test";
export const TEST_DOMAIN = "redline.test";

export const noChain: Chain = {
  async getSourceOutput() {
    return null;
  },
  async isUnspentOrSpentBy() {
    return false;
  },
  async getUtxos() {
    return [];
  },
};

export function testApp(
  o: { reader: ChainReader; now?: () => Date; config?: Partial<AppDeps["config"]> } & Partial<Omit<AppDeps, "reader" | "now" | "config">>,
) {
  const db = o.db ?? openDatabase(":memory:");
  const secrets = o.secrets ?? createSecrets("s".repeat(32));
  const app = createApp({
    reader: o.reader,
    db,
    chain: o.chain ?? noChain,
    secrets,
    config: { loginDomain: TEST_DOMAIN, publicOrigin: TEST_ORIGIN, trustProxyHops: 0, ...o.config },
    ...(o.now && { now: o.now }),
    ...(o.botUsername && { botUsername: o.botUsername }),
  });
  return { app, db, secrets };
}
