import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTelegramUpdate, type TgUpdate } from "../src/telegram/client.js";

function update(overrides: Partial<TgUpdate["message"]> = {}): TgUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 42, first_name: "小明", last_name: "王", username: "ming" },
      chat: { id: 42, type: "private", first_name: "小明", last_name: "王", username: "ming" },
      text: "哈囉",
      ...overrides,
    },
  };
}

describe("normalizeTelegramUpdate", () => {
  it("私人訊息：chat 與 from 為使用者名稱（優先 @username）", () => {
    const msg = normalizeTelegramUpdate(update());
    assert.deepEqual(msg, {
      chat: "42",
      fromId: "42",
      fromName: "@ming",
      chatName: "@ming",
      text: "哈囉",
    });
  });

  it("群組：chatName 用群組標題", () => {
    const msg = normalizeTelegramUpdate(
      update({
        chat: { id: -100123, type: "group", title: "測試群" },
      }),
    );
    assert.equal(msg?.chat, "-100123");
    assert.equal(msg?.chatName, "測試群");
    assert.equal(msg?.fromName, "@ming");
  });

  it("無 username 時以名字組出 fromName", () => {
    const msg = normalizeTelegramUpdate(
      update({
        from: { id: 7, first_name: "阿寶" },
        chat: { id: 7, type: "private", first_name: "阿寶" },
      }),
    );
    assert.equal(msg?.fromId, "7");
    assert.equal(msg?.fromName, "阿寶");
    assert.equal(msg?.chatName, "阿寶");
  });

  it("caption 可作為文字來源（圖片說明）", () => {
    const msg = normalizeTelegramUpdate(update({ text: undefined, caption: "  看這個  " }));
    assert.equal(msg?.text, "看這個");
  });

  it("機器人訊息回 null", () => {
    const msg = normalizeTelegramUpdate(
      update({ from: { id: 1, is_bot: true, first_name: "Bot" } }),
    );
    assert.equal(msg, null);
  });

  it("無文字（貼圖/檔案）回 null", () => {
    const msg = normalizeTelegramUpdate(update({ text: undefined, caption: undefined }));
    assert.equal(msg, null);
  });

  it("缺少 message / from / chat 回 null", () => {
    assert.equal(normalizeTelegramUpdate({ update_id: 1 }), null);
    assert.equal(normalizeTelegramUpdate(update({ from: undefined })), null);
    assert.equal(normalizeTelegramUpdate(update({ chat: undefined })), null);
  });

  it("空白文字回 null", () => {
    const msg = normalizeTelegramUpdate(update({ text: "   " }));
    assert.equal(msg, null);
  });
});
