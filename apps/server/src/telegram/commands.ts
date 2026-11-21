// Pure Telegram command logic: text in, reply text out. Replies are plain text (sent without
// parse_mode), so nothing dynamic needs escaping.
import { PARYON_APP_URL, type RiskBand } from "@redline/api-types";
import type { Db } from "../db.js";
import type { ChainReader } from "../reader.js";
import { tokenHash } from "../tokens.js";

export interface CommandDeps {
  db: Pick<Db, "consumeLinkToken" | "linkTelegramChat" | "accountForChat" | "getTelegramChat" | "listWatches" | "setChatMute">;
  reader: Pick<ChainReader, "current">;
  /** unix seconds */
  now: () => number;
  /** the site, e.g. https://redline.app (PUBLIC_ORIGIN) */
  publicOrigin?: string;
}

export const MAX_MUTE_SECONDS = 7 * 86400;
/** Telegram's limit is 4096; keep a margin */
export const MAX_REPLY_CHARS = 4000;
const DEFAULT_MUTE_SECONDS = 86400;
const START_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
const UNIT: Record<string, number> = { m: 60, h: 3600, d: 86400 };
const ICON: Record<RiskBand, string> = { safe: "🟢", watch: "🟡", danger: "🟠", critical: "🔴" };

const LINKED = "✅ Linked. You'll get Redline alerts here. /status to see your watches.";
const EXPIRED = "That link has expired. Open Redline and press Connect Telegram again.";
const NOT_LINKED = "This chat isn't linked yet. Open Redline, sign in and press Connect Telegram.";
const MUTE_USAGE = "Usage: /mute (24 h), /mute 2h, /mute 30m or /mute 3d (max 7 days).";
const HELP = [
  "Redline warns you before your ParyonUSD loan is liquidated.",
  "",
  "/status — your watched loans right now",
  "/mute — pause alerts for 24 h (/mute 2h, /mute 30m, max 7d)",
  "/unmute — turn alerts back on",
  "/help — this list",
].join("\n");

/** "2h" → 7200 s; undefined → 24 h; capped at 7 days; null when invalid */
export function parseDuration(arg: string | undefined): number | null {
  if (arg === undefined) return DEFAULT_MUTE_SECONDS;
  const m = /^(\d{1,6})([mhd])$/i.exec(arg.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  return Math.min(n * UNIT[m[2]!.toLowerCase()]!, MAX_MUTE_SECONDS);
}

const utc = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const pct = (x: number | null) => (x === null ? "n/a" : `${x.toFixed(1)}%`);
const usd = (x: number | null) => (x === null ? "n/a" : `$${x.toFixed(2)}`);

function status(accountId: string, chatId: string, deps: CommandDeps): string {
  const watches = deps.db.listWatches(accountId);
  const chat = deps.db.getTelegramChat(accountId);
  const mutedNote =
    chat && chat.chatId === chatId && chat.mutedUntil !== null && chat.mutedUntil > deps.now()
      ? [`🔕 Alerts muted until ${utc(chat.mutedUntil)}. /unmute to turn them back on.`, ""]
      : [];
  if (watches.length === 0) {
    return [...mutedNote, "You have no watches yet. Add one on the Redline site to get alerts here."].join("\n");
  }
  const s = deps.reader.current();
  if (!s) return [...mutedNote, "Loan data is still loading, try again in a minute."].join("\n");
  const lines = watches.map((w) => {
    const id = w.loanId.slice(0, 8);
    const loan = s.byId.get(w.loanId);
    if (!loan) return `${id} — loan closed`;
    const dist = loan.distanceToLiquidation === null ? null : loan.distanceToLiquidation * 100;
    return `${id} — CR ${pct(loan.collateralRatioPct)} · ${pct(dist)} from liquidation · liq ${usd(loan.liquidationPriceUsd)} · ${ICON[loan.risk]} ${loan.risk.toUpperCase()}`;
  });
  const head = [...mutedNote, `Your watches (BCH ${usd(s.priceUsd)}):`];
  const tail = ["", `Act in the Paryon app: ${PARYON_APP_URL}`];
  const build = (shown: string[], more: number) =>
    [...head, ...shown, ...(more > 0 ? [`…and ${more} more`] : []), ...tail].join("\n");
  let n = lines.length;
  while (n > 0 && build(lines.slice(0, n), lines.length - n).length > MAX_REPLY_CHARS) n--;
  return build(lines.slice(0, n), lines.length - n);
}

export function handleCommand(msg: { text: string; chatId: string }, deps: CommandDeps): string {
  const text = msg.text.trim();
  if (!text.startsWith("/")) return "Send /help to see what I can do.";
  const [head = "", ...args] = text.split(/\s+/);
  const cmd = head.split("@")[0]!.toLowerCase();
  const t = deps.now();

  switch (cmd) {
    case "/start": {
      const token = args[0];
      if (token === undefined) {
        const site = deps.publicOrigin ?? "the Redline site";
        return `👋 This is Redline. It warns you on Telegram before your ParyonUSD loan gets liquidated.\n\nTo get alerts, open ${site}, sign in with your wallet and press Connect Telegram.\n\n/help for commands.`;
      }
      if (!START_TOKEN.test(token)) return EXPIRED;
      const accountId = deps.db.consumeLinkToken(tokenHash(token), t);
      if (!accountId) return EXPIRED;
      deps.db.linkTelegramChat(accountId, msg.chatId, t);
      return LINKED;
    }
    case "/status": {
      const accountId = deps.db.accountForChat(msg.chatId);
      return accountId ? status(accountId, msg.chatId, deps) : NOT_LINKED;
    }
    case "/mute": {
      if (!deps.db.accountForChat(msg.chatId)) return NOT_LINKED;
      const secs = parseDuration(args[0]);
      if (secs === null) return MUTE_USAGE;
      deps.db.setChatMute(msg.chatId, t + secs);
      return `🔕 Alerts muted until ${utc(t + secs)}. /unmute to turn them back on.`;
    }
    case "/unmute": {
      if (!deps.db.accountForChat(msg.chatId)) return NOT_LINKED;
      deps.db.setChatMute(msg.chatId, null);
      return "🔔 Alerts are back on.";
    }
    case "/help":
      return HELP;
    default:
      return "Unknown command. Send /help to see what I can do.";
  }
}
