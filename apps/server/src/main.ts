import { serve } from "@hono/node-server";
import { electrumHosts, fetchSnapshot } from "@redline/paryon-decoder";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { openDb } from "./db.js";
import { createElectrumChain } from "./electrum.js";
import { createChainReader } from "./reader.js";

const config = parseConfig(process.env);
const { port, refreshMs: intervalMs, timeoutMs } = config;
// ELECTRUM_HOST (if set) first, then the public fallbacks
const hostnames = electrumHosts(config.electrumHost);

const reader = createChainReader({
  fetch: () => fetchSnapshot({ hostnames, log: (m) => console.log(m) }),
  intervalMs,
  timeoutMs,
});
reader.start();

const db = openDb(config.dbPath);
const chain = createElectrumChain({ hostnames });

const server = serve({ fetch: createApp({ reader, db, chain, config }).fetch, port }, () => {
  console.log(`Redline API on http://localhost:${port}/api (login domain ${config.loginDomain})`);
});

const shutdown = () => {
  reader.stop();
  server.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
