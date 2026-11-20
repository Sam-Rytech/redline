import { describe, expect, it } from "vitest";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDb } from "../src/db.js";
import { BOT_CLIENT_TIMEOUT_SECONDS, createTelegramBot, POLL_TIMEOUT_SECONDS } from "../src/telegram/bot.js";
import { tokenHash } from "../src/tokens.js";

const NOW = 1_800_000_000;
const botInfo: UserFromGetMe = {
  id: 42, is_bot: true, first_name: "Redline", username: "RedlineBot",
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
} as UserFromGetMe;

function setup() {
  const db = openDb(":memory:");
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const { bot, sendMessage } = createTelegramBot({
    token: "123:TEST",
    botInfo,
    deps: { db, reader: { current: () => null }, now: () => NOW },
    log: (m) => logs.push(m),
  });
  // intercept every Bot API call: no network
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "sendMessage" && (payload as { chat_id: unknown }).chat_id === "403") {
      return { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } as never;
    }
    return { ok: true, result: { message_id: 1, date: NOW, chat: { id: 1, type: "private" } } } as never;
  });
  let updateId = 1;
  const message = (text: string, chat: { id: number; type: "private" | "group" } = { id: 555, type: "private" }): Update =>
    ({
      update_id: updateId++,
      message: {
        message_id: updateId, date: NOW, text,
        chat: chat.type === "private" ? { id: chat.id, type: "private", first_name: "U" } : { id: chat.id, type: "group", title: "G" },
        from: { id: 7, is_bot: false, first_name: "U" },
        ...(text.startsWith("/") && { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] }),
      },
    }) as Update;
  return { db, bot, calls, logs, message, sendMessage };
}

describe("grammY adapter", () => {
  it("routes a private /start <token> through handleCommand and replies in plain text", async () => {
    const s = setup();
    s.db.insertLinkToken(tokenHash("tok"), "acc", NOW, NOW + 600);
    await s.bot.handleUpdate(s.message("/start tok"));
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.method).toBe("sendMessage");
    expect(s.calls[0]!.payload.chat_id).toBe(555);
    expect(s.calls[0]!.payload.text).toMatch(/^✅ Linked/);
    expect(s.calls[0]!.payload.parse_mode).toBeUndefined();
    expect(s.db.accountForChat("555")).toBe("acc");
  });

  it("refuses to work in group chats: commands get a 'message me directly' reply", async () => {
    const s = setup();
    s.db.insertLinkToken(tokenHash("tok"), "acc", NOW, NOW + 600);
    await s.bot.handleUpdate(s.message("/start tok", { id: -100, type: "group" }));
    expect(s.calls[0]!.payload.text).toMatch(/message me directly/i);
    expect(s.db.accountForChat("-100")).toBeNull();
  });

  it("never replies to plain text in groups", async () => {
    const s = setup();
    await s.bot.handleUpdate(s.message("hello everyone", { id: -100, type: "group" }));
    expect(s.calls).toEqual([]);
  });

  it("Bot API calls time out after 15 s; long polling waits less than that", () => {
    const s = setup();
    expect(BOT_CLIENT_TIMEOUT_SECONDS).toBe(15);
    expect((s.bot as unknown as { clientConfig?: { timeoutSeconds?: number } }).clientConfig?.timeoutSeconds).toBe(15);
    expect(POLL_TIMEOUT_SECONDS).toBeLessThan(BOT_CLIENT_TIMEOUT_SECONDS);
  });

  it("sendMessage sends plain text without link previews; failures reject (the runner logs them)", async () => {
    const s = setup();
    await s.sendMessage("555", "hello");
    expect(s.calls[0]).toEqual({
      method: "sendMessage",
      payload: { chat_id: "555", text: "hello", link_preview_options: { is_disabled: true } },
    });
    await expect(s.sendMessage("403", "x")).rejects.toThrow(/blocked/);
  });
});
