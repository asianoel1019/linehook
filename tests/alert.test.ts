import { describe, it, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { config } from "../src/config.js";
import { buildWebhookPayload, redactUrl, sendAlert } from "../src/notify/alert.js";

let server: Server;
let port = 0;
const received: Array<{ url: string; body: Record<string, string> }> = [];

async function listen(srv: Server): Promise<number> {
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve((srv.address() as AddressInfo).port));
  });
}

describe("sendAlert", () => {
  const originalAlert = { ...config.alert };
  const originalSmtp = { ...config.smtp };

  before(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        try {
          received.push({ url: req.url ?? "", body: JSON.parse(raw) as Record<string, string> });
        } catch {
          received.push({ url: req.url ?? "", body: {} });
        }
        res.writeHead(200).end("ok");
      });
    });
    port = await listen(server);
  });

  after(() => {
    server.close();
  });

  beforeEach(() => {
    received.length = 0;
    config.alert = { ...originalAlert, webhookUrls: [], deadmanUrl: "", deadletterThreshold: 0, resendMinutes: 30 };
    config.smtp = { ...originalSmtp, host: "", from: "", to: "" };
  });

  afterEach(() => {
    config.alert = { ...originalAlert };
    config.smtp = { ...originalSmtp };
  });

  it("webhook 通道送達且 payload 同時相容 Slack / Discord / ntfy", async () => {
    const url = `http://127.0.0.1:${port}/services/T0000/B0000/XYZ`;
    config.alert.webhookUrls = [url];

    const outcomes = await sendAlert("[IM Webhook] 測試", "測試內文");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].channel, "webhook");
    assert.equal(outcomes[0].ok, true);

    assert.equal(received.length, 1);
    const body = received[0].body;
    assert.equal(body.title, "[IM Webhook] 測試");
    assert.match(body.text as string, /\[IM Webhook\] 測試\n測試內文/);
    assert.equal(body.content, body.text, "Discord 用 content");
    assert.equal(body.message, body.text, "ntfy 用 message");
    assert.equal(body.topic, "XYZ", "ntfy topic 取自 URL 最後一段");
  });

  it("單一通道失敗不影響其他通道，回報每條通道結果", async () => {
    const good = `http://127.0.0.1:${port}/ok`;
    const bad = "http://127.0.0.1:1/refused"; // 連線被拒
    config.alert.webhookUrls = [bad, good];

    const outcomes = await sendAlert("主旨", "內文");
    assert.equal(outcomes.length, 2);
    const ok = outcomes.filter((o) => o.ok).length;
    assert.equal(ok, 1, "只會有一條成功");
    assert.equal(received.length, 1, "失敗的通道不該送出");
  });

  it("完全沒設定通道時回空陣列（由呼叫端判定為設定缺失）", async () => {
    const outcomes = await sendAlert("主旨", "內文");
    assert.deepEqual(outcomes, []);
    assert.equal(received.length, 0);
  });

  it("redactUrl 只留 origin，不把路徑 token 寫進 log", () => {
    assert.equal(redactUrl("https://hooks.slack.com/services/ABC/DEF/GHI?x=1"), "https://hooks.slack.com");
    assert.equal(redactUrl("not a url"), "(無效 URL)");
  });

  it("buildWebhookPayload 用安全欄位組出通知文字", () => {
    const p = buildWebhookPayload("S", "B", "https://ntfy.sh/imwebhook");
    assert.equal(p.title, "S");
    assert.equal(p.topic, "imwebhook");
    assert.equal(p.text, "S\nB");
  });
});
