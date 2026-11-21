import { serve } from "@hono/node-server";
import { createSnapshotFetcher, electrumHosts } from "@redline/paryon-decoder";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { createSecrets } from "./crypto.js";
import { startBackups } from "./db/backup.js";
import { openDatabase } from "./db/open.js";
import { startRetention } from "./db/retention.js";
import { recordSnapshot } from "./db/snapshots.js";
import { createAlertRunner } from "./alerts.js";
import { chatOfAccount } from "./db/telegram.js";
import { createElectrumChain } from "./electrum.js";
import { startTelegramBot } from "./telegram/bot.js";
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

// Telegram alerts and linking run only with a bot token. One running server per token.
const telegram = config.telegramBotToken
  ? startTelegramBot({
      token: config.telegramBotToken,
      deps: { db, reader, now: () => Math.floor(Date.now() / 1000), publicOrigin: config.publicOrigin },
    })
  : null;
if (telegram) {
  const alerts = createAlertRunner({ db, sendMessage: telegram.sendMessage });
  reader.onUpdate((prev, next) => alerts.onUpdate(prev, next));
} else {
  console.warn("warning: TELEGRAM_BOT_TOKEN is not set; Telegram linking and alerts are off");
}
reader.start();

const chain = createElectrumChain({ hostnames });
if (!config.merchantAddress) console.warn("warning: MERCHANT_ADDRESS is not set; the Pro pass cannot be bought");
const app = createApp({
  reader,
  db,
  chain,
  ...(config.merchantAddress && { payments: { merchantAddress: config.merchantAddress, chain } }),
  notifyAccount: async (accountId, text) => {
    const chatId = chatOfAccount(db, accountId);
    if (telegram && chatId) await telegram.sendMessage(chatId, text);
  },
  secrets: createSecrets(config.sessionSecret),
  config,
  botUsername: () => telegram?.username(),
});

const server = serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Redline API on http://localhost:${config.port}/api (login domain ${config.loginDomain})`);
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  reader.stop();
  stopRetention();
  stopBackups();
  // let the bot finish its poll so updates are not delivered twice, but never wait more than 3 s
  if (telegram) await Promise.race([telegram.stop().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  server.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
