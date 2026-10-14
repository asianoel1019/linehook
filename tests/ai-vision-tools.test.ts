import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseSubscribe } from "../src/skills/bus/index.js";
import { toVisionContent, type LlmConfig } from "../src/skills/llm.js";
import { runAgent } from "../src/skills/agent.js";
import { chatWithTools } from "../src/skills/llm.js";
import { executeTool, TOOL_SPECS } from "../src/skills/tools.js";

describe("bus parseSubscribe", () => {
  it("路線＋站牌＋提前分鐘", () => {
    const s = parseSubscribe("307 台北車站 5");
    assert.equal(s?.route, "307");
    assert.equal(s?.stop, "台北車站");
    assert.equal(s?.thresholdMin, 5);
  });

  it("城市关键字萃取", () => {
    assert.equal(parseSubscribe("307 台北車站")?.city, "Taipei");
    assert.equal(parseSubscribe("紅57 高雄車站")?.city, "Kaohsiung");
  });

  it("省略分鐘用預設值", () => {
    const s = parseSubscribe("307 台北車站", 3);
    assert.equal(s?.thresholdMin, 3);
  });

  it("沒有站牌回 null", () => {
    assert.equal(parseSubscribe("307"), null);
    assert.equal(parseSubscribe(""), null);
  });

  it("分鐘超出範圍退回預設", () => {
    const s = parseSubscribe("307 台北車站 99", 5);
    assert.equal(s?.thresholdMin, 5);
  });
});

describe("toVisionContent", () => {
  it("沒有圖片回純字串", () => {
    assert.equal(toVisionContent("hello", []), "hello");
    assert.equal(toVisionContent("hello", undefined), "hello");
  });

  it("有圖片組出 text＋image_url parts", () => {
    const parts = toVisionContent("這是什麼", [{ base64: "AAA", mimeType: "image/jpeg" }]);
    assert.ok(Array.isArray(parts));
    const list = parts as Array<Record<string, unknown>>;
    assert.equal(list.length, 2);
    assert.equal(list[0].type, "text");
    assert.equal(list[1].type, "image_url");
    assert.match(String((list[1].image_url as { url: string }).url), /^data:image\/jpeg;base64,AAA$/);
  });

  it("只有圖片時給預設提問", () => {
    const parts = toVisionContent("", [{ base64: "AAA", mimeType: "image/png" }]) as Array<Record<string, unknown>>;
    assert.equal(parts[0].text, "請看這張圖片並描述內容。");
  });

  it("最多帶四張", () => {
    const imgs = Array.from({ length: 6 }, (_, i) => ({ base64: `B${i}`, mimeType: "image/jpeg" }));
    const parts = toVisionContent("x", imgs) as Array<Record<string, unknown>>;
    assert.equal(parts.length, 1 + 4);
  });
});

/* ── llm 工具呼叫（fetch stub） ── */

const realFetch = globalThis.fetch;

function openAiCfg(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "openai",
    baseUrl: "https://api.test/v1",
    apiKey: "k",
    model: "gpt-test",
    systemPrompt: "",
    temperature: 0.5,
    maxTokens: 512,
    timeoutMs: 5000,
    ...over,
  };
}

interface Captured {
  bodies: Array<Record<string, unknown>>;
}

function stubFetch(handler: (url: string, body: Record<string, unknown>) => unknown): Captured {
  const captured: Captured = { bodies: [] };
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    captured.bodies.push(body);
    const payload = handler(String(url), body);
    const text = JSON.stringify(payload);
    const buf = Buffer.from(text, "utf8");
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      // llm.ts 的協定實作直接用 res.json()；net.ts 路徑用 arrayBuffer——兩者都給。
      json: async () => JSON.parse(text),
      text: async () => text,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    } as unknown as Response;
  }) as typeof fetch;
  return captured;
}

describe("chatWithTools（OpenAI 相容協定）", () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("模型回 tool_calls 時解析出名稱與參數", async () => {
    const cap = stubFetch(() => ({
      choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"台北"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    const result = await chatWithTools(openAiCfg(), [{ role: "user", content: "台北天氣如何" }], TOOL_SPECS);
    assert.equal(result.toolCalls?.length, 1);
    assert.equal(result.toolCalls?.[0].name, "get_weather");
    assert.deepEqual(result.toolCalls?.[0].args, { city: "台北" });
    // 請求有帶 tools 與 tool_choice
    const body = cap.bodies[0] as { tools?: Array<{ function?: { name?: string } }>; tool_choice?: string };
    assert.equal(body.tool_choice, "auto");
    assert.ok((body.tools ?? []).some((t) => t.function?.name === "get_weather"));
  });

  it("模型直接回文字時回 text", async () => {
    stubFetch(() => ({ choices: [{ message: { content: "你好" } }] }));
    const result = await chatWithTools(openAiCfg(), [{ role: "user", content: "hi" }], TOOL_SPECS);
    assert.equal(result.text, "你好");
    assert.equal(result.toolCalls, undefined);
  });

  it("壞 JSON 參數不爆（回空物件）", async () => {
    stubFetch(() => ({ choices: [{ message: { tool_calls: [{ id: "c", function: { name: "get_stock", arguments: "not-json" } }] } }] }));
    const result = await chatWithTools(openAiCfg(), [{ role: "user", content: "股價" }], TOOL_SPECS);
    assert.deepEqual(result.toolCalls?.[0].args, {});
  });
});

describe("chatWithTools（Gemini 協定）", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("functionCall 解析；工具結果用 functionResponse 結構回餵", async () => {
    const cap = stubFetch(() => ({
      candidates: [{ content: { parts: [{ text: "1 美元約 31 元" }] } }],
      usageMetadata: {},
    }));

    const messages = [
      { role: "user" as const, content: "美金多少" },
      { role: "model" as const, content: "", functionCall: [{ name: "get_exchange_rate", args: { from: "USD" } }] },
      { role: "user" as const, content: "", functionResponse: [{ name: "get_exchange_rate", result: "1 USD ≈ 31.2 TWD" }] },
    ];
    const result = await chatWithTools({ ...openAiCfg(), provider: "gemini" }, messages, TOOL_SPECS);
    assert.equal(result.text, "1 美元約 31 元");

    // 請求的 contents：functionCall 與 functionResponse 都照協定序列化
    const contents = ((cap.bodies[0] as { contents: Array<{ parts: Array<Record<string, unknown>> }> }).contents) ?? [];
    const kinds = contents.flatMap((c) => c.parts.map((p) => Object.keys(p)[0]));
    assert.ok(kinds.includes("text"));
    assert.ok(kinds.includes("functionCall"));
    assert.ok(kinds.includes("functionResponse"));
  });
});

describe("runAgent", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("兩輪：工具 → 結果 → 純文字", async () => {
    let round = 0;
    const cap = stubFetch((url) => {
      if (!url.includes("api.test")) {
        // 工具內部（Yahoo）的呼叫：回一份可用報價
        return { chart: { result: [{ meta: { regularMarketPrice: 900, shortName: "台積電" } }] } };
      }
      round += 1;
      if (round === 1) {
        return { choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "get_stock", arguments: '{"symbol":"2330"}' } }] } }], usage: {} };
      }
      return { choices: [{ message: { content: "台積電目前約 900 元" } }], usage: {} };
    });

    const result = await runAgent(openAiCfg(), {
      system: "你是助手",
      prompt: "台積電股價？",
      tools: true,
    });
    assert.equal(result.text, "台積電目前約 900 元");
    assert.equal(result.toolRounds, 1);

    // 第二輪請求須含 assistant(tool_calls) 與 role:tool 結果
    const chatBodies = cap.bodies.filter((b) => Array.isArray((b as { messages?: unknown }).messages));
    const messages = (chatBodies[1] as { messages: Array<Record<string, unknown>> }).messages ?? [];
    const roles = messages.map((m) => m.role);
    assert.ok(roles.includes("assistant"));
    assert.ok(roles.includes("tool"));
    const toolMsg = messages.find((m) => m.role === "tool");
    assert.match(String(toolMsg?.content ?? ""), /900/);
  });

  it("關閉工具時只單輪 chat", async () => {
    const cap = stubFetch(() => ({ choices: [{ message: { content: "純問答" } }], usage: {} }));
    const result = await runAgent(openAiCfg(), { system: "", prompt: "hi", tools: false });
    assert.equal(result.text, "純問答");
    assert.equal(result.toolRounds, 0);
    assert.equal((cap.bodies[0] as { tools?: unknown }).tools, undefined);
  });

  it("超過工具輪數上限時明確報錯", async () => {
    stubFetch(() => ({ choices: [{ message: { tool_calls: [{ id: "c", function: { name: "get_weather", arguments: "{}" } }] } }], usage: {} }));
    await assert.rejects(
      runAgent(openAiCfg(), { system: "", prompt: "無限呼叫", tools: true, maxRounds: 2 }),
      /工具往返超過上限/,
    );
  });

  it("Antigravity CLI 模式不支援工具 → 明確錯誤", async () => {
    await assert.rejects(
      runAgent({ ...openAiCfg(), provider: "gemini-cli" }, { system: "", prompt: "hi", tools: true }),
      /不支援工具呼叫/,
    );
  });

  it("OpenCode CLI 模式不支援工具 → 明確錯誤", async () => {
    await assert.rejects(
      runAgent({ ...openAiCfg(), provider: "opencode-cli" }, { system: "", prompt: "hi", tools: true }),
      /不支援工具呼叫/,
    );
  });
});

describe("executeTool 參數驗證", () => {
  it("缺參數回可讀錯誤（不打 API）", async () => {
    assert.match(await executeTool("get_weather", {}, {}), /缺少 city/);
    assert.match(await executeTool("get_stock", {}, {}), /缺少 symbol/);
    assert.match(await executeTool("get_exchange_rate", {}, {}), /缺少 from/);
  });

  it("未知工具回提示", async () => {
    assert.match(await executeTool("nope", {}, {}), /未知工具/);
  });

  it("查無城市時把錯誤轉成文字（不炸）", async () => {
    const out = await executeTool("get_weather", { city: "外星" }, {});
    assert.match(out, /工具執行失敗|查無/);
  });
});
