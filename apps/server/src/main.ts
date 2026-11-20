import { serve } from "@hono/node-server";
import { fetchSnapshot } from "@redline/paryon-decoder";
import { createApp } from "./app.js";
import { createChainReader } from "./reader.js";

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.ELECTRUM_HOST || undefined;
const intervalMs = Number(process.env.REFRESH_MS ?? 60_000);

const reader = createChainReader({
  fetch: () => fetchSnapshot(hostname ? { hostname } : {}),
  intervalMs,
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
