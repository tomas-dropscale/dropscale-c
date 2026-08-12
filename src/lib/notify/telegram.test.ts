import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { escapeHtml, sendTelegram, telegramConfig } from "./telegram";

const CONFIG = { token: "bot-token", chatId: "-100123" };

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("telegramConfig", () => {
  it("is null until both secrets are set", () => {
    expect(telegramConfig()).toBeNull();

    process.env.TELEGRAM_BOT_TOKEN = "t";
    expect(telegramConfig()).toBeNull();

    process.env.TELEGRAM_CHAT_ID = "c";
    expect(telegramConfig()).toEqual({ token: "t", chatId: "c" });
  });

  it("trims the whitespace `wrangler secret put` leaves on a pasted value", () => {
    process.env.TELEGRAM_BOT_TOKEN = " 123:AAH\n";
    process.env.TELEGRAM_CHAT_ID = "-100123\n";
    expect(telegramConfig()).toEqual({ token: "123:AAH", chatId: "-100123" });
  });

  it("treats a whitespace-only secret as unset", () => {
    process.env.TELEGRAM_BOT_TOKEN = "  ";
    process.env.TELEGRAM_CHAT_ID = "-100123";
    expect(telegramConfig()).toBeNull();
  });
});

describe("sendTelegram", () => {
  it("posts the message to the configured chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegram("olá", { config: CONFIG });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botbot-token/sendMessage");
    expect(JSON.parse(init.body)).toMatchObject({
      chat_id: "-100123",
      text: "olá",
      parse_mode: "HTML",
    });
  });

  it("reports unconfigured without reaching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await sendTelegram("olá")).toEqual({ ok: false, reason: "unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Telegram's own reason when it rejects the message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"description":"chat not found"}', { status: 400 })),
    );

    const result = await sendTelegram("olá", { config: CONFIG });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("rejected");
      expect(result.detail).toContain("chat not found");
    }
  });

  it("never throws when the network is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));

    const result = await sendTelegram("olá", { config: CONFIG });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unreachable");
      expect(result.detail).toContain("ECONNREFUSED");
    }
  });
});

describe("escapeHtml", () => {
  it("escapes the three characters Telegram's HTML mode chokes on", () => {
    expect(escapeHtml('<b>&"')).toBe('&lt;b&gt;&amp;"');
  });

  it("escapes the ampersand first so entities are not double-encoded", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});
