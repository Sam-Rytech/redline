// Thin grammY adapter: long polling → handleCommand → plain-text reply. All logic lives in commands.ts.
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { handleCommand, type CommandDeps } from "./commands.js";

const PRIVATE_ONLY = "Please message me directly — alerts and loan details are only sent in a private chat.";

export function createTelegramBot(opts: {
  token: string;
  deps: CommandDeps;
  /** skip getMe (tests) */
  botInfo?: UserFromGetMe;
  log?: (msg: string) => void;
}) {
  const log = opts.log ?? ((m: string) => console.log(m));
  const bot = new Bot(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : {});

  bot.on("message:text", async (ctx) => {
    const options = { link_preview_options: { is_disabled: true } };
    if (ctx.chat.type !== "private") {
      await ctx.reply(PRIVATE_ONLY, options);
      return;
    }
    const reply = handleCommand({ text: ctx.message.text, chatId: String(ctx.chat.id) }, opts.deps);
    await ctx.reply(reply, options);
  });
  bot.catch((e) => log(`telegram update failed: ${e.message}`));

  /** for the alert runner; rejects on failure */
  const sendMessage = async (chatId: string, text: string): Promise<void> => {
    await bot.api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } });
  };
  return { bot, sendMessage };
}

const INIT_RETRY_MS = 30_000;

/**
 * Start long polling in the background. Returns at once: `sendMessage` works immediately (it does not
 * need getMe), `username()` is BOT_USERNAME or, once known, the name from getMe (retried every 30 s
 * while Telegram is unreachable).
 */
export function startTelegramBot(opts: {
  token: string;
  username?: string;
  deps: CommandDeps;
  log?: (msg: string) => void;
}): { username: () => string | undefined; sendMessage: (chatId: string, text: string) => Promise<void>; stop: () => Promise<void> } {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { bot, sendMessage } = createTelegramBot({ token: opts.token, deps: opts.deps, log });
  let username = opts.username;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const launch = async (): Promise<void> => {
    if (stopped) return;
    try {
      await bot.init(); // getMe
    } catch (e) {
      log(`Telegram getMe failed (${msg(e)}); retrying in ${INIT_RETRY_MS / 1000}s`);
      retry = setTimeout(() => void launch(), INIT_RETRY_MS);
      return;
    }
    username ??= bot.botInfo.username;
    bot
      .start({ onStart: (info) => log(`Telegram bot @${info.username} polling`) })
      .catch((e: unknown) => log(`Telegram bot stopped: ${msg(e)}`));
  };
  void launch();

  return {
    username: () => username,
    sendMessage,
    stop: async () => {
      stopped = true;
      clearTimeout(retry);
      if (bot.isRunning()) await bot.stop();
    },
  };
}
