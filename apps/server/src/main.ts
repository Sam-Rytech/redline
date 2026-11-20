import { serve } from "@hono/node-server";
import { createSnapshotFetcher, electrumHosts } from "@redline/paryon-decoder";
import { createAlertRunner } from "./alerts.js";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { openDb } from "./db.js";
import { createElectrumChain } from "./electrum.js";
import { createChainReader } from "./reader.js";
import { startTelegramBot } from "./telegram/bot.js";

const config = parseConfig(process.env);
const { port, refreshMs: intervalMs, timeoutMs } = config;
// ELECTRUM_HOST (if set) first, then the public fallbacks
const hostnames = electrumHosts(config.electrumHost);

const reader = createChainReader({
  fetch: createSnapshotFetcher({ hostnames, log: (m) => console.log(m) }),
  intervalMs,
  timeoutMs,
});
const db = openDb(config.dbPath);
const chain = createElectrumChain({ hostnames });

// Telegram bot + alerts only when TELEGRAM_BOT_TOKEN is set
const telegram = config.telegramBotToken
  ? startTelegramBot({
      token: config.telegramBotToken,
      ...(config.botUsername && { username: config.botUsername }),
      deps: { db, reader, now: () => Math.floor(Date.now() / 1000), ...(config.publicOrigin && { publicOrigin: config.publicOrigin }) },
    })
  : null;
if (telegram) {
  const alerts = createAlertRunner({ db, sendMessage: telegram.sendMessage });
  reader.onUpdate((prev, next) => alerts.onUpdate(prev, next));
} else {
  console.log("TELEGRAM_BOT_TOKEN not set: Telegram bot and alerts are off");
}
reader.start();

if (!config.merchantAddress) console.log("MERCHANT_ADDRESS not set: Pro pass payments are off (invoice routes answer 503)");
const app = createApp({
  reader,
  db,
  chain,
  config,
  botUsername: () => telegram?.username(),
  ...(config.merchantAddress && { payments: { merchantAddress: config.merchantAddress, chain } }),
});
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`Redline API on http://localhost:${port}/api (login domain ${config.loginDomain})`);
});

const BOT_STOP_WAIT_MS = 3000;
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  reader.stop();
  // let grammY confirm the last update offset, but never hang the exit on Telegram
  if (telegram) {
    await Promise.race([telegram.stop().catch(() => {}), new Promise((r) => setTimeout(r, BOT_STOP_WAIT_MS))]);
  }
  server.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
