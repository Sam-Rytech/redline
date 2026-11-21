import { serve } from "@hono/node-server";
import { fetchSnapshot } from "@redline/paryon-decoder";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { startBackups } from "./db/backup.js";
import { openDatabase } from "./db/open.js";
import { startRetention } from "./db/retention.js";
import { recordSnapshot } from "./db/snapshots.js";
import { createChainReader } from "./reader.js";

const config = parseConfig(process.env);
for (const w of config.warnings) console.warn(`warning: ${w}`);

const db = openDatabase(config.databasePath);
const stopRetention = startRetention(db);
const stopBackups = config.backupDir ? startBackups(db, config.backupDir) : () => {};

const reader = createChainReader({
  fetch: () => fetchSnapshot(config.electrumHost ? { hostname: config.electrumHost } : {}),
  intervalMs: config.refreshMs,
  timeoutMs: config.timeoutMs,
});
reader.onUpdate((_prev, next) => {
  recordSnapshot(db, { blockHeight: next.blockHeight, loans: next.raw });
});
reader.start();

const server = serve({ fetch: createApp({ reader }).fetch, port: config.port }, () => {
  console.log(`Redline API on http://localhost:${config.port}/api`);
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
