import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { dispatchIncoming, type DispatchDeps } from "../src/messaging/dispatch.js";
import aiSkill, { resolveToolsEnabled } from "../src/skills/ai/index.js";
import { loadSkills } from "../src/skills/loader.js";

await loadSkills();

const saved = {
  assistant: { ...config.assistant },
  commands: { ...config.commands, allowFrom: [...config.commands.allowFrom] },
  forward: [...config.forward],
  skills: [...config.skills],
};

beforeEach(() => {
  config.assistant = { enabled: true, name: "阿寶" };
  config.commands = { enabled: false, prefix: "!", allowFrom: [] };
  config.forward = [];
  config.skills = [
    {
      id: "ai",
      enabled: true,
      trigger: "問",
      allowedUsers: [],
      config: {
        provider: "openai",
        baseUrl: "https://api.test/v1",
        apiKey: "k",
        model: "gpt-test",
        tools: "off",
        memory: "off",
      },
    },
  ];
});

afterEach(() => {
  config.assistant = { ...saved.assistant };
  config.commands = { ...saved.commands, allowFrom: [...saved.commands.allowFrom] };
  config.forward = [...saved.forward];
  config.skills = [...saved.skills];
});

function deps(replies: string[]): DispatchDeps {
  return {
    platform: "test",
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
  };
}

describe("管線：圖片附件傳遞", () => {
  it("any 模式技能收得到 images（純圖片訊息也能觸發）", async () => {
    const replies: string[] = [];
    // 訊息沒有文字、只有圖片 → 純圖片也要能餵給技能
    config.skills = [{ id: "ai", enabled: true, trigger: "", allowedUsers: [], config: { mode: "any" } }];
    await dispatchIncoming(
      {
        chat: "c1",
        fromId: "u1",
        fromName: "小明",
        chatName: "",
        text: "",
        images: [{ base64: "QUJD", mimeType: "image/jpeg" }],
        messageId: "img-1",
      },
      deps(replies),
    );
    // AI 技能未設定 API key（mode any 但 config 空）→ 回失敗訊息；重點是它有被觸發
    assert.match(replies[0], /AI 回覆失敗/);
  });

  it("純圖片也不被其他技能誤觸發（助理前綴不成立）", async () => {
    const replies: string[] = [];
    await dispatchIncoming(
      {
        chat: "c1",
        fromId: "u1",
        fromName: "小明",
        chatName: "",
        text: "",
        images: [{ base64: "QUJD", mimeType: "image/png" }],
        messageId: "img-2",
      },
      deps(replies),
    );
    assert.equal(replies.length, 0, "助理模式技能不該被純圖片觸發");
  });
});

describe("AI 技能 vision", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stub(payload: unknown): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
      const text = JSON.stringify(payload);
      const buf = Buffer.from(text, "utf8");
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => JSON.parse(text),
        text: async () => text,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      } as unknown as Response;
    }) as typeof fetch;
    return bodies;
  }

  it("圖片＋問題一起送：content 為 parts（text＋image_url）", async () => {
    const bodies = stub({ choices: [{ message: { content: "這是一張貓的照片" } }], usage: {} });
    const replies: string[] = [];
    await aiSkill.run({
      text: "這是什麼",
      args: "這是什麼",
      fromName: "小明",
      chat: "c1",
      fromMid: "u1",
      config: {
        provider: "openai",
        baseUrl: "https://api.test/v1",
        apiKey: "k",
        model: "gpt-test",
        tools: "off",
        memory: "off",
      },
      images: [{ base64: "QUJD", mimeType: "image/jpeg" }],
      reply: async (t: string) => {
        replies.push(t);
      },
      sendImage: async () => {},
      sendFile: async () => {},
      schedule: () => "",
      watch: () => "",
      unwatch: () => true,
      watches: () => [],
      taskState: () => undefined,
    });
    assert.deepEqual(replies, ["這是一張貓的照片"]);

    const messages = (bodies[0] as { messages: Array<{ role: string; content: unknown }> }).messages;
    const user = messages.find((m) => m.role === "user");
    const parts = user?.content as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(parts));
    assert.equal(parts[0].type, "text");
    assert.equal(parts[1].type, "image_url");
    assert.match(String((parts[1].image_url as { url: string }).url), /data:image\/jpeg;base64,QUJD/);
    // 系統提示帶了圖片專用指示
    const system = messages.find((m) => m.role === "system");
    assert.match(String(system?.content), /不要臆測圖片外的資訊/);
  });

  it("工具開啟時發工具宣告", async () => {
    const bodies = stub({ choices: [{ message: { content: "台北 28 度" } }], usage: {} });
    await aiSkill.run({
      text: "台北天氣",
      args: "台北天氣",
      fromName: "小明",
      chat: "c1",
      fromMid: "u1",
      config: {
        provider: "openai",
        baseUrl: "https://api.test/v1",
        apiKey: "k",
        model: "gpt-test",
        tools: "on",
        memory: "off",
      },
      reply: async () => {},
      sendImage: async () => {},
      sendFile: async () => {},
      schedule: () => "",
      watch: () => "",
      unwatch: () => true,
      watches: () => [],
      taskState: () => undefined,
    });
    const tools = (bodies[0] as { tools?: Array<{ function?: { name?: string } }> }).tools ?? [];
    assert.ok(tools.some((t) => t.function?.name === "get_weather"));
  });

  it("清除記憶關鍵字仍可用", async () => {
    const replies: string[] = [];
    await aiSkill.run({
      text: "清除記憶",
      args: "清除記憶",
      fromName: "小明",
      chat: "c1",
      fromMid: "u1",
      config: {},
      reply: async (t: string) => {
        replies.push(t);
      },
      sendImage: async () => {},
      sendFile: async () => {},
      schedule: () => "",
      watch: () => "",
      unwatch: () => true,
      watches: () => [],
      taskState: () => undefined,
    });
    assert.deepEqual(replies, ["已清除本對話的記憶。"]);
  });
});

describe("resolveToolsEnabled", () => {
  it("預設開啟；off 關閉；gemini-cli 強制單輪", () => {
    assert.equal(resolveToolsEnabled(undefined, "openai"), true);
    assert.equal(resolveToolsEnabled("on", "gemini"), true);
    assert.equal(resolveToolsEnabled("off", "openai"), false);
    assert.equal(resolveToolsEnabled(undefined, "gemini-cli"), false);
    assert.equal(resolveToolsEnabled("on", "gemini-cli"), false);
    assert.equal(resolveToolsEnabled(undefined, "opencode-cli"), false);
    assert.equal(resolveToolsEnabled("on", "opencode-cli"), false);
  });
});
