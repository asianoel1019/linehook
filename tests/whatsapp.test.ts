import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  normalizeWhatsAppWebhook,
  verifyWhatsAppSignature,
  type WaWebhook,
} from "../src/whatsapp/client.js";

function webhook(overrides: Record<string, unknown> = {}): WaWebhook {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "886900000000", phone_number_id: "111" },
              contacts: [{ profile: { name: "小明" }, wa_id: "886912345678" }],
              messages: [
                {
                  id: "wamid.abc",
                  from: "886912345678",
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: "哈囉" },
                },
              ],
              ...overrides,
            },
          },
        ],
      },
    ],
  };
}

describe("normalizeWhatsAppWebhook", () => {
  it("文字訊息正規化", () => {
    const msgs = normalizeWhatsAppWebhook(webhook());
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], {
      chat: "886912345678",
      fromId: "886912345678",
      fromName: "小明",
      chatName: "886900000000",
      text: "哈囉",
      messageId: "wamid.abc",
    });
  });

  it("button 訊息取按鈕文字", () => {
    const msgs = normalizeWhatsAppWebhook(
      webhook({
        messages: [{ id: "1", from: "886900000001", type: "button", button: { text: "確認" } }],
      }),
    );
    assert.equal(msgs[0]?.text, "確認");
  });

  it("非文字（無 text/button）回空陣列", () => {
    const msgs = normalizeWhatsAppWebhook(
      webhook({ messages: [{ id: "1", from: "886900000001", type: "image" }] }),
    );
    assert.equal(msgs.length, 0);
  });

  it("多筆訊息全部取出", () => {
    const msgs = normalizeWhatsAppWebhook(
      webhook({
        messages: [
          { id: "1", from: "111", type: "text", text: { body: "a" } },
          { id: "2", from: "222", type: "text", text: { body: "b" } },
        ],
      }),
    );
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].text, "a");
    assert.equal(msgs[1].text, "b");
  });

  it("空 / 非預期 payload 回空陣列", () => {
    assert.deepEqual(normalizeWhatsAppWebhook({}), []);
    assert.deepEqual(normalizeWhatsAppWebhook({ entry: [] }), []);
  });

  it("聯絡人無名稱時回退為號碼", () => {
    const msgs = normalizeWhatsAppWebhook(webhook({ contacts: [] }));
    assert.equal(msgs[0]?.fromName, "886912345678");
  });
});

describe("verifyWhatsAppSignature", () => {
  const secret = "app-secret-123";
  const body = Buffer.from(JSON.stringify({ hello: "世界" }), "utf8");

  it("正確簽章通過", () => {
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    assert.equal(verifyWhatsAppSignature(body, sig, secret), true);
  });

  it("錯誤簽章失敗", () => {
    assert.equal(verifyWhatsAppSignature(body, "sha256=deadbeef", secret), false);
  });

  it("缺少 sha256= 前綴失敗", () => {
    const hex = createHmac("sha256", secret).update(body).digest("hex");
    assert.equal(verifyWhatsAppSignature(body, hex, secret), false);
  });

  it("未設 appSecret 時放行", () => {
    assert.equal(verifyWhatsAppSignature(body, "", ""), true);
  });
});
