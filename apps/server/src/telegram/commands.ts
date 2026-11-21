// Telegram command logic: text in, reply text out. Replies are plain text (sent without parse_mode),
// so nothing needs escaping. Voice per docs/BRAND.md: plain, specific, calm; no emojis.
import { PARYON_APP_URL } from "@redline/api-types";
import { sha256Hex } from "../crypto.js";
import type { Db } from "../db/open.js";
import { listWatches } from "../db/watches.js";
import { accountForChat, consumeLinkToken, isMuted, linkChat, setMuted } from "../db/telegram.js";
import type { ChainReader } from "../reader.js";

export interface CommandDeps {
  db: Db;
  reader: Pick<ChainReader, "current">;
  /** unix seconds */
  now: () => number;
  /** the site, e.g. https://redline.example (PUBLIC_ORIGIN) */
  publicOrigin?: string;
}

/** Telegram's limit is 4096; keep a margin */
export const MAX_REPLY_CHARS = 4000;
const START_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

const LINKED = "Linked. Redline alerts for your watched loans will come to this chat. Send /status to see them now.";
const EXPIRED = "That link has expired or was already used. Open Redline and press Connect Telegram again.";
const NOT_LINKED = "This chat is not linked yet. Open Redline, sign in with your wallet and press Connect Telegram.";
export const HELP = [
  "Redline tells you before your ParyonUSD loan gets close to liquidation.",
  "",
  "/status - your watched loans now",
  "/mute - stop alerts until you send /unmute",
  "/unmute - turn alerts back on",
  "/help - this list",
].join("\n");

const pct = (x: number | null) => (x === null ? "n/a" : `${x.toFixed(1)}%`);
const usd = (x: number | null) => (x === null ? "n/a" : `$${x.toFixed(2)}`);

function status(accountId: string, deps: CommandDeps): string {
  const watches = listWatches(deps.db, accountId);
  const mutedNote = isMuted(deps.db, accountId) ? ["Alerts are muted. Send /unmute to turn them back on.", ""] : [];
  if (watches.length === 0) {
    return [...mutedNote, "You are not watching any loan yet. Add one on the Redline site to get alerts here."].join("\n");
  }
  const s = deps.reader.current();
  if (!s) return [...mutedNote, "Loan data is still loading. Try again in a minute."].join("\n");
  const lines = watches.map((w) => {
    const id = w.loanId.slice(0, 8);
    const loan = s.byId.get(w.loanId);
    if (!loan) return `${id}: no longer open`;
    if (loan.stranded) return `${id}: repaid, ${loan.collateralBch.toFixed(4)} BCH left to claim in the Paryon app`;
    const dist = loan.distanceToLiquidation === null ? null : loan.distanceToLiquidation * 100;
    return `${id}: ${pct(dist)} from liquidation, liquidation price ${usd(loan.liquidationPriceUsd)}, collateral ratio ${pct(loan.collateralRatioPct)}`;
  });
  const head = [...mutedNote, `Your watched loans (BCH ${usd(s.priceUsd)}):`];
  const tail = ["", `Act in the Paryon app: ${PARYON_APP_URL}`];
  const build = (shown: string[], more: number) => [...head, ...shown, ...(more > 0 ? [`and ${more} more`] : []), ...tail].join("\n");
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
        return `This is Redline. It tells you on Telegram before your ParyonUSD loan gets close to liquidation.\n\nTo get alerts, open ${site}, sign in with your wallet and press Connect Telegram.\n\nSend /help for the commands.`;
      }
      if (!START_TOKEN.test(token)) return EXPIRED;
      const accountId = consumeLinkToken(deps.db, sha256Hex(token), t);
      if (!accountId) return EXPIRED;
      linkChat(deps.db, accountId, msg.chatId, t);
      return LINKED;
    }
    case "/status": {
      const accountId = accountForChat(deps.db, msg.chatId);
      return accountId ? status(accountId, deps) : NOT_LINKED;
    }
    case "/mute": {
      const accountId = accountForChat(deps.db, msg.chatId);
      if (!accountId) return NOT_LINKED;
      setMuted(deps.db, accountId, true);
      return "Alerts are muted. Send /unmute to turn them back on.";
    }
    case "/unmute": {
      const accountId = accountForChat(deps.db, msg.chatId);
      if (!accountId) return NOT_LINKED;
      setMuted(deps.db, accountId, false);
      return "Alerts are on again.";
    }
    case "/help":
      return HELP;
    default:
      return "Unknown command. Send /help to see what I can do.";
  }
}
