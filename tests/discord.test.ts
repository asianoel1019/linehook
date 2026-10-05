import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeDiscordMessage } from "../src/discord/client.js";

const BOT_ID = "987654321098765432";

function evt(overrides: Partial<NonNullable<Parameters<typeof normalizeDiscordMessage>[0]["d"]>> = {}) {
  return {
    d: {
      id: "111222333444555666",
      channel_id: "123456789012345678",
      author: { id: "555666777888999000", username: "alice" },
      content: "哈囉",
      ...overrides,
    },
  };
}

describe("normalizeDiscordMessage", () => {
  it("一般訊息正規化（含 channel/content/messageId）", () => {
    const msg = normalizeDiscordMessage(evt(), BOT_ID);
    assert.deepEqual(msg, {
      chat: "123456789012345678",
      fromId: "555666777888999000",
      fromName: "alice",
      chatName: "",
      text: "哈囉",
      messageId: "111222333444555666",
    });
  });

  it("member.nick 優先於 username", () => {
    const msg = normalizeDiscordMessage(evt({ member: { nick: "愛麗絲" } }), BOT_ID);
    assert.equal(msg?.fromName, "愛麗絲");
  });

  it("機器人訊息回 null", () => {
    assert.equal(normalizeDiscordMessage(evt({ author: { id: "1", username: "bot", bot: true } }), BOT_ID), null);
  });

  it("自己的訊息（author id === selfId）回 null", () => {
    assert.equal(normalizeDiscordMessage(evt({ author: { id: BOT_ID, username: "me" } }), BOT_ID), null);
  });

  it("空內容回 null", () => {
    assert.equal(normalizeDiscordMessage(evt({ content: "   " }), BOT_ID), null);
    assert.equal(normalizeDiscordMessage(evt({ content: undefined }), BOT_ID), null);
  });

  it("缺 channel_id 或 author 回 null", () => {
    assert.equal(normalizeDiscordMessage({ d: { id: "1", author: { id: "2", username: "a" } } }, BOT_ID), null);
    assert.equal(normalizeDiscordMessage({ d: { id: "1", channel_id: "3" } }, BOT_ID), null);
    assert.equal(normalizeDiscordMessage({}, BOT_ID), null);
  });

  it("內容去頭尾空白", () => {
    const msg = normalizeDiscordMessage(evt({ content: "  訊息  " }), BOT_ID);
    assert.equal(msg?.text, "訊息");
  });
});
