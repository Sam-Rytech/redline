import { Hono, type Context } from "hono";
import type { ApiError, LoansResponse } from "@redline/api-types";
import { summarize } from "@redline/paryon-decoder";
import type { ChainReader } from "./reader.js";

const err = (code: string, message: string): ApiError => ({ error: { code, message } });
const STALE_MS = 5 * 60_000;
const CACHE_CONTROL = "public, max-age=15";

export function createApp(deps: { reader: ChainReader; now?: () => Date }) {
  const { reader } = deps;
  const now = deps.now ?? (() => new Date());
  const app = new Hono().basePath("/api");

  app.notFound((c) => c.json(err("not_found", "No such route"), 404));
  app.onError((e, c) => {
    console.error(e);
    return c.json(err("internal", "Internal error"), 500);
  });

  const notReady = (c: Context) =>
    c.json(err("not_ready", "Loading chain data, try again in a few seconds"), 503);

  app.get("/health", (c) => {
    const s = reader.current();
    const stale = !s || now().getTime() - new Date(s.updatedAt).getTime() > STALE_MS;
    return c.json({
      ok: true,
      blockHeight: s?.blockHeight ?? null,
      updatedAt: s?.updatedAt ?? null,
      stale,
      lastError: reader.lastError(),
    });
  });

  app.get("/loans", (c) => {
    const s = reader.current();
    if (!s) return notReady(c);
    const body: LoansResponse = {
      blockHeight: s.blockHeight,
      priceUsd: s.priceUsd,
      updatedAt: s.updatedAt,
      summary: summarize(s.loans),
      loans: s.loans,
    };
    c.header("Cache-Control", CACHE_CONTROL);
    return c.json(body);
  });

  app.get("/loans/:id", (c) => {
    const s = reader.current();
    if (!s) return notReady(c);
    const loan = s.byId.get(c.req.param("id"));
    if (!loan) return c.json(err("not_found", "No such loan"), 404);
    c.header("Cache-Control", CACHE_CONTROL);
    return c.json(loan);
  });

  return app;
}
