import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeDiscordMessage } from "../src/discord/client.js";
import { normalizeTelegramUpdate } from "../src/telegram/client.js";

describe("P3 進站語音：adapter 層", () => {
  it("Discord：只有語音附件（無文字）也要收", () => {
    const msg = normalizeDiscordMessage(
      {
        d: {
          id: "m1",
          channel_id: "c1",
          author: { id: "u1", username: "Neal" },
          content: "",
          attachments: [{ url: "https://cdn/x.webm", voice: true, content_type: "audio/ogg" }],
        },
      },
      "bot",
    );
    assert.ok(msg, "語音訊息不該被丟掉");
    assert.equal(msg.text, "");
    assert.equal(msg.chat, "c1");
  });

  it("Discord：純附件沒有語音仍然丟掉", () => {
    const msg = normalizeDiscordMessage(
      {
        d: {
          id: "m2",
          channel_id: "c1",
          author: { id: "u1", username: "Neal" },
          content: "",
          attachments: [{ url: "https://cdn/x.png" }],
        },
      },
      "bot",
    );
    assert.equal(msg, null);
  });

  it("Telegram：voice 訊息要被收（文字可空）", () => {
    const msg = normalizeTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 2,
        from: { id: 1, is_bot: false, first_name: "Neal" },
        chat: { id: 100, type: "group" },
        voice: { file_id: "f1", mime_type: "audio/ogg", duration: 3000 },
      },
    });
    assert.ok(msg, "語音訊息不該被丟掉");
    assert.equal(msg.text, "");
  });

  it("Telegram：audio 訊息也要收", () => {
    const msg = normalizeTelegramUpdate({
      update_id: 2,
      message: {
        message_id: 3,
        from: { id: 1, is_bot: false, first_name: "Neal" },
        chat: { id: 100, type: "private" },
        audio: { file_id: "f2", mime_type: "audio/mpeg" },
      },
    });
    assert.ok(msg);
  });
});
