import { serve } from "@hono/node-server";
import { createSnapshotFetcher, electrumHosts } from "@redline/paryon-decoder";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { createSecrets } from "./crypto.js";
import { startBackups } from "./db/backup.js";
import { openDatabase } from "./db/open.js";
import { startRetention } from "./db/retention.js";
import { recordSnapshot } from "./db/snapshots.js";
import { createElectrumChain } from "./electrum.js";
import { createChainReader } from "./reader.js";

const config = parseConfig(process.env);
for (const w of config.warnings) console.warn(`warning: ${w}`);

const db = openDatabase(config.databasePath);
const stopRetention = startRetention(db);
const stopBackups = config.backupDir ? startBackups(db, config.backupDir) : () => {};

const hostnames = electrumHosts(config.electrumHost);
const reader = createChainReader({
  fetch: createSnapshotFetcher({ hostnames, log: (m) => console.log(m) }),
  intervalMs: config.refreshMs,
  timeoutMs: config.timeoutMs,
});
reader.onUpdate((_prev, next) => {
  recordSnapshot(db, { blockHeight: next.blockHeight, loans: next.raw });
});
reader.start();

const app = createApp({
  reader,
  db,
  chain: createElectrumChain({ hostnames }),
  secrets: createSecrets(config.sessionSecret),
  config,
});

const server = serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Redline API on http://localhost:${config.port}/api (login domain ${config.loginDomain})`);
});

const shutdown = () => {
  reader.stop();
  stopRetention();
  stopBackups();
  server.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
