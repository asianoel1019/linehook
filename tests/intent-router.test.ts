import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { config } from "../src/config.js";
import { dispatchIncoming, type DispatchDeps } from "../src/messaging/dispatch.js";
import { loadSkills } from "../src/skills/loader.js";
import {
  buildRouterMessages,
  parseRouterReply,
  classifyIntent,
  collectRouterCandidates,
  routerAvailable,
  clearIntentCache,
} from "../src/messaging/intent-router.js";

await loadSkills();

const savedGlobalLlm = { ...config.globalLlm };
const savedSkills = [...config.skills];
const savedAssistant = { ...config.assistant };
const savedCache = config.cachePath;
const savedFetch = globalThis.fetch;

beforeEach(() => {
  config.assistant = { enabled: true, name: "阿寶" };
  config.commands = { enabled: false, prefix: "!", allowFrom: [] };
  config.forward = [];
  clearIntentCache();
});

afterEach(() => {
  config.globalLlm = { ...savedGlobalLlm };
  config.skills = [...savedSkills];
  config.assistant = { ...savedAssistant };
  config.cachePath = savedCache;
  globalThis.fetch = savedFetch;
});

function makeDeps(): DispatchDeps & { replies: string[] } {
  const replies: string[] = [];
  return {
    replies,
    platform: "line",
    replyTo: async (_chat, text) => { replies.push(text); },
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

const msg = (text: string, extra: Record<string, unknown> = {}) => ({
  chat: "U_router_user",
  fromId: "u1",
  fromName: "tester",
  chatName: "",
  text,
  ...extra,
});

describe("parseRouterReply", () => {
  const ids = new Set(["weather", "stock"]);
  it("正常 JSON", () => {
    assert.deepEqual(parseRouterReply('{"skill":"weather","args":"台北"}', ids), {
      skillId: "weather",
      args: "台北",
    });
  });

  it("包在廢話裡也抓得到；null 表無關", () => {
    assert.deepEqual(parseRouterReply('好的：\n{"skill":null}', ids), { skillId: null, args: "" });
  });

  it("壞格式、未知 id、缺 args 的處理", () => {
    assert.equal(parseRouterReply("不是 JSON", ids), null);
    assert.equal(parseRouterReply('{"skill":"ghost","args":"x"}', ids), null);
    assert.equal(parseRouterReply('{"skill":123}', ids), null);
    assert.deepEqual(parseRouterReply('{"skill":"stock"}', ids), { skillId: "stock", args: "" });
  });
});

describe("buildRouterMessages", () => {
  it("含技能清單與原文", () => {
    const msgs = buildRouterMessages("明早會下雨嗎", [{ id: "weather", blurb: "天氣：查天氣" }]);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, "system");
    assert.ok(String(msgs[0].content).includes("weather"));
    assert.equal(msgs[1].content, "明早會下雨嗎");
  });
});

describe("classifyIntent（含快取）", () => {
  const cands = [{ id: "weather", blurb: "天氣" }];

  it("成功回傳決策；同文第二次不重打", async () => {
    let calls = 0;
    const chatFn = async () => {
      calls++;
      return '{"skill":"weather","args":"台北"}';
    };
    const r1 = await classifyIntent("台北天氣如何呢", cands, chatFn);
    const r2 = await classifyIntent("台北天氣如何呢", cands, chatFn);
    assert.deepEqual(r1, { skillId: "weather", args: "台北" });
    assert.deepEqual(r2, r1);
    assert.equal(calls, 1);
  });

  it("模型炸掉回 null（不拋）", async () => {
    const r = await classifyIntent(
      "xxx",
      cands,
      async () => {
        throw new Error("斷線");
      },
    );
    assert.equal(r, null);
  });

  it("空字串與空候選直接回 null", async () => {
    assert.equal(await classifyIntent("  ", cands, async () => '{"skill":"weather"}'), null);
    assert.equal(await classifyIntent("hi", [], async () => '{"skill":"weather"}'), null);
  });
});

describe("routerAvailable", () => {
  it("無模型關閉；local 免 key 開啟；openai 看 key", () => {
    config.globalLlm = { ...savedGlobalLlm, provider: "openai", model: "", apiKey: "" };
    assert.equal(routerAvailable(), false);
    config.globalLlm = { ...savedGlobalLlm, provider: "local", model: "m", apiKey: "" };
    assert.equal(routerAvailable(), true);
    config.globalLlm = { ...savedGlobalLlm, provider: "openai", model: "m", apiKey: "" };
    assert.equal(routerAvailable(), false);
    config.globalLlm = { ...savedGlobalLlm, provider: "openai", model: "m", apiKey: "k" };
    assert.equal(routerAvailable(), true);
  });
});

describe("collectRouterCandidates", () => {
  it("只收啟用、有觸發詞、非 any 技能", () => {
    config.skills = [
      { id: "weather", enabled: true, trigger: "", allowedUsers: [], config: {} },
      { id: "ghost", enabled: true, trigger: "", allowedUsers: [], config: {} },
      { id: "auto-reply", enabled: true, trigger: "", allowedUsers: [], config: {} },
      { id: "stock", enabled: false, trigger: "", allowedUsers: [], config: {} },
    ];
    const ids = collectRouterCandidates().map((c) => c.id);
    assert.deepEqual(ids, ["weather"]);
  });
});

describe("LLM 後備 E2E", () => {
  function stubFetch() {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        // 只看 user 那句（system 本來就列了所有技能名）
        let userText = "";
        try {
          const body = JSON.parse(String((init as { body?: unknown })?.body ?? "")) as {
            messages?: Array<{ role?: string; content?: string }>;
          };
          userText = body.messages?.filter((m) => m.role === "user").map((m) => m.content ?? "").join("\n") ?? "";
        } catch {
          userText = "";
        }
        const skill = userText.includes("天氣") ? '{"skill":"weather","args":"台北"}' : '{"skill":null}';
        return new Response(JSON.stringify({ choices: [{ message: { content: skill } }] }));
      }
      return new Response(
        JSON.stringify({ current_condition: [{ temp_C: "25", FeelsLikeC: "28", humidity: "84", weatherDesc: [{ value: "晴" }] }] }),
      );
    }) as typeof fetch;
  }

  it("自然問句經 LLM 直達天氣", async () => {
    const d = makeDeps();
    config.globalLlm = { ...savedGlobalLlm, provider: "openai", baseUrl: "http://stub/v1", apiKey: "k", model: "m" };
    config.skills = [{ id: "weather", enabled: true, trigger: "", allowedUsers: [], config: {} }];
    config.cachePath = mkdtempSync(join(tmpdir(), "router-e2e-"));
    stubFetch();
    await dispatchIncoming(msg("幫我查一下台北的天氣狀況", { messageId: "router-e2e-1" }), d);
    assert.equal(d.replies.length, 1);
    assert.match(d.replies[0], /台北 天氣/);
  });

  it("閒聊回 null，不打擾", async () => {
    const d = makeDeps();
    config.globalLlm = { ...savedGlobalLlm, provider: "openai", baseUrl: "http://stub/v1", apiKey: "k", model: "m" };
    config.skills = [{ id: "weather", enabled: true, trigger: "", allowedUsers: [], config: {} }];
    config.cachePath = mkdtempSync(join(tmpdir(), "router-e2e-"));
    stubFetch();
    await dispatchIncoming(msg("哈哈哈今天真開心", { messageId: "router-e2e-2" }), d);
    assert.deepEqual(d.replies, []);
  });

  it("沒配 LLM 時後備自動關閉", async () => {
    const d = makeDeps();
    config.globalLlm = { ...savedGlobalLlm, provider: "openai", baseUrl: "", apiKey: "", model: "" };
    config.skills = [{ id: "weather", enabled: true, trigger: "", allowedUsers: [], config: {} }];
    await dispatchIncoming(msg("幫我查一下台北的天氣狀況", { messageId: "router-e2e-3" }), d);
    assert.deepEqual(d.replies, []);
  });
});
