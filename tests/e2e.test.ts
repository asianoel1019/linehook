import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// 所有路徑都必須在 config 載入前決定（config 在 import 時讀 env）
const dir = mkdtempSync(join(tmpdir(), "e2e-"));
process.env.SCHEDULES_PATH = join(dir, "schedules.json");
process.env.STATS_PATH = join(dir, "stats.jsonl");
const skillsDir = join(dir, "skills", "echo-skill");
mkdirSync(skillsDir, { recursive: true });
writeFileSync(
  join(skillsDir, "index.js"),
  `export default {
    id: "echo-skill",
    name: "回音",
    defaultTrigger: "echo",
    async run(ctx) { await ctx.reply("回音：" + ctx.args); },
  };\n`,
);
process.env.SKILLS_PATH = join(dir, "skills");

const { config } = await import("../src/config.js");
const { TelegramService } = await import("../src/telegram/client.js");
const { registerService } = await import("../src/messaging/services.js");
const { createServer } = await import("../src/webhook/server.js");
const { dispatchIncoming } = await import("../src/messaging/dispatch.js");
const { loadSkills } = await import("../src/skills/loader.js");

const saved = {
  apiToken: config.apiToken,
  apiTokenEnabled: config.apiTokenEnabled,
  apiTokens: config.apiTokens,
  hmacSecret: config.hmacSecret,
  hmacEnabled: config.hmacEnabled,
  webhookToken: config.webhookToken,
  webhookTokenEnabled: config.webhookTokenEnabled,
  assistant: { ...config.assistant },
  skills: [...config.skills],
  telegram: { ...config.telegram },
};

const fetchCalls: Array<{ url: string; body: unknown }> = [];
const realFetch = globalThis.fetch;

let server: Server;
let base = "";

before(async () => {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    // 只攔截打向 Telegram Bot API 的呼叫；測項自身的 HTTP 走真 fetch
    if (!u.includes("api.telegram.org")) return realFetch(url as string, init);
    let body: unknown = undefined;
    try {
      body = JSON.parse(String((init?.body as string) ?? ""));
    } catch {
      /* ignore */
    }
    fetchCalls.push({ url: u, body });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) } as Response;
  }) as typeof fetch;

  config.telegram.botToken = "111:xxx";
  config.hmacSecret = "";
  config.hmacEnabled = true;
  config.webhookToken = "";
  config.webhookTokenEnabled = true;
  config.apiToken = "";
  config.apiTokenEnabled = true;
  config.apiTokens = [{ name: "e2e", token: "e2e-send", scopes: ["send"] }];
  // 規則模擬路由是 read 權限（唯讀），給它一支 read token
  config.apiTokens.push({ name: "e2e-read", token: "e2e-read-token", scopes: ["read"] });

  const tg = new TelegramService();
  registerService(tg);

  const app = createServer(tg);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await loadSkills();
  config.assistant = { enabled: true, name: "阿寶" };
  config.skills = [{ id: "echo-skill", enabled: true, trigger: "echo", allowedUsers: [], config: {} }];
});

after(async () => {
  globalThis.fetch = realFetch;
  config.apiToken = saved.apiToken;
  config.apiTokenEnabled = saved.apiTokenEnabled;
  config.apiTokens = saved.apiTokens;
  config.hmacSecret = saved.hmacSecret;
  config.hmacEnabled = saved.hmacEnabled;
  config.webhookToken = saved.webhookToken;
  config.webhookTokenEnabled = saved.webhookTokenEnabled;
  config.assistant = saved.assistant;
  config.skills = saved.skills;
  config.telegram = saved.telegram;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("e2e: webhook 發送 → 真實 adapter（mock fetch）", () => {
  it("POST /webhook/tg 打到 Telegram Bot API", async () => {
    fetchCalls.length = 0;
    const res = await fetch(`${base}/webhook/tg`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer e2e-send" },
      body: JSON.stringify({ to: "12345", text: "哈囉" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, count: 1 });
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /\/bot111:xxx\/sendMessage$/);
    const body = fetchCalls[0].body as { chat_id?: string; text?: string };
    assert.equal(body.chat_id, "12345");
    assert.equal(body.text, "哈囉");
  });

  it("未知目標回錯誤、不打 API", async () => {
    fetchCalls.length = 0;
    const res = await fetch(`${base}/webhook/tg`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer e2e-send" },
      body: JSON.stringify({ to: "not a target!!!", text: "hi" }),
    });
    assert.equal(res.status, 404);
    assert.equal(fetchCalls.length, 0);
  });
});

describe("e2e: 收訊 → dispatch → 真實技能回覆", () => {
  it("阿寶請幫忙 echo hi → 回音：hi", async () => {
    const replies: string[] = [];
    await dispatchIncoming(
      { chat: "999", fromId: "u9", fromName: "e2e", chatName: "", text: "阿寶請幫忙 echo hi", messageId: "e2e-1" },
      {
        platform: "telegram",
        replyTo: async (_chat, text) => {
          replies.push(text);
        },
        sendAdvanced: async () => {},
        sendMedia: async () => {},
        schedule: () => ({}) as never,
        scheduleSkillTask: () => ({}) as never,
        listSkillTasks: () => [],
        readTaskState: () => undefined,
        saveTaskState: () => true,
        cancelScheduledTask: () => true,
        enqueueText: async () => {},
        getQueueStats: () => ({ pending: 0, running: false }),
        listScheduled: () => [],
      },
    );
    assert.deepEqual(replies, ["回音：hi"]);
  });
});

describe("e2e: 規則模擬路由（唯讀）", () => {
  const post = (body: unknown, token = "e2e-read-token") =>
    fetch(`${base}/console/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it("命中設定的技能並回傳分階段結果", async () => {
    const res = await post({
      text: "阿寶請幫忙 echo hi",
      chat: "c1",
      fromId: "u1",
      fromName: "小明",
      chatName: "群組",
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      ok: boolean;
      result: { stages: Array<{ stage: string; outcome: string; detail: string }>; rendered: string };
    };
    assert.equal(data.ok, true);
    const skill = data.result.stages.find((s) => s.stage === "skill");
    assert.equal(skill?.outcome, "hit");
    assert.match(skill?.detail ?? "", /echo/);
    assert.match(data.result.rendered, /\[模擬\] 阿寶請幫忙 echo hi/);
  });

  it("空文字回 400", async () => {
    const res = await post({ text: "" });
    assert.equal(res.status, 400);
  });

  it("send 權限的 token 不能模擬（read 才可；不足回 401）", async () => {
    const res = await post({ text: "阿寶請幫忙 echo hi" }, "e2e-send");
    assert.equal(res.status, 401);
  });
});
