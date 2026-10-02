import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTeamsActivity,
  flexToAdaptiveCard,
  verifyTeamsJwt,
  type TeamsActivity,
} from "../src/teams/client.js";

function activity(overrides: Partial<TeamsActivity> = {}): TeamsActivity {
  return {
    type: "message",
    id: "1",
    text: "哈囉",
    from: { id: "29:user-id", name: "小明" },
    conversation: { id: "19:abc@thread.v2", name: "客服頻道", tenantId: "t1", conversationType: "channel" },
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/apac/",
    recipient: { id: "28:bot-id", name: "Bot" },
    ...overrides,
  };
}

describe("normalizeTeamsActivity", () => {
  it("文字訊息正規化", () => {
    const msg = normalizeTeamsActivity(activity());
    assert.deepEqual(msg, {
      chat: "19:abc@thread.v2",
      fromId: "29:user-id",
      fromName: "小明",
      chatName: "客服頻道",
      text: "哈囉",
    });
  });

  it("非 message 型別回 null", () => {
    assert.equal(normalizeTeamsActivity(activity({ type: "conversationUpdate" })), null);
    assert.equal(normalizeTeamsActivity(activity({ type: "typing" })), null);
  });

  it("空文字回 null", () => {
    assert.equal(normalizeTeamsActivity(activity({ text: "   " })), null);
    assert.equal(normalizeTeamsActivity(activity({ text: undefined })), null);
  });

  it("機器人自己的回覆（from === recipient）回 null", () => {
    assert.equal(
      normalizeTeamsActivity(activity({ from: { id: "28:bot-id", name: "Bot" } })),
      null,
    );
  });

  it("缺少 conversation id 回 null", () => {
    assert.equal(normalizeTeamsActivity(activity({ conversation: undefined })), null);
  });

  it("一對一訊息可用 user id 當 from", () => {
    const msg = normalizeTeamsActivity(
      activity({
        from: { id: "8:orgid:user", name: "阿寶" },
        conversation: { id: "a:conv-1", conversationType: "personal" },
      }),
    );
    assert.equal(msg?.chat, "a:conv-1");
    assert.equal(msg?.fromName, "阿寶");
  });
});

describe("flexToAdaptiveCard", () => {
  it("轉譯 Flex bubble 的文字節點", () => {
    const card = flexToAdaptiveCard({
      altText: "地震速報",
      contents: {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: "標題" },
            { type: "text", text: "內文" },
            { type: "image", url: "https://x/y.png" },
          ],
        },
      },
    });
    assert.equal(card.type, "AdaptiveCard");
    assert.equal(card.$schema, "http://adaptivecards.io/schemas/adaptive-card.json");
    const body = card.body as Array<{ type: string; text: string }>;
    assert.deepEqual(body.map((b) => b.text), ["標題", "內文"]);
  });

  it("無文字節點時用 altText 兜底", () => {
    const card = flexToAdaptiveCard({ altText: "備用文字", contents: {} });
    const body = card.body as Array<{ type: string; text: string }>;
    assert.deepEqual(body.map((b) => b.text), ["備用文字"]);
  });
});

describe("verifyTeamsJwt（本機可驗證的拒絕路徑）", () => {
  it("缺少 / 錯誤 Authorization 回 false", async () => {
    assert.equal(await verifyTeamsJwt("", "app-id"), false);
    assert.equal(await verifyTeamsJwt("Token abc", "app-id"), false);
  });

  it("結構錯誤的 JWT 回 false（不打網路）", async () => {
    assert.equal(await verifyTeamsJwt("Bearer not.a.jwt", "app-id"), false);
    assert.equal(await verifyTeamsJwt("Bearer a.b.c.d", "app-id"), false);
  });

  it("非 RS256 alg 回 false（不打網路）", async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${b64({ alg: "HS256", kid: "x" })}.${b64({ aud: "app-id" })}.sig`;
    assert.equal(await verifyTeamsJwt(`Bearer ${token}`, "app-id"), false);
  });
});
