import { serve } from "@hono/node-server";
import { fetchSnapshot } from "@redline/paryon-decoder";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { createChainReader } from "./reader.js";

const { port, electrumHost: hostname, refreshMs: intervalMs, timeoutMs } = parseConfig(process.env);

const reader = createChainReader({
  fetch: () => fetchSnapshot(hostname ? { hostname } : {}),
  intervalMs,
  timeoutMs,
});
reader.start();

const server = serve({ fetch: createApp({ reader }).fetch, port }, () => {
  console.log(`Redline API on http://localhost:${port}/api`);
});

const shutdown = () => {
  reader.stop();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
