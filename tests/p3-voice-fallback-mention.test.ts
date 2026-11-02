import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { transcribeAudio, sttConfig, type SttConfig } from "../src/messaging/stt.js";
import { mentionPrefix, withMentions } from "../src/messaging/mentions.js";
import { fallbackOrder, sendWithFallback } from "../src/messaging/fallback.js";

const savedProvider = config.sttProvider;
const savedApiKey = config.sttApiKey;
const savedBaseUrl = config.sttBaseUrl;
const savedModel = config.sttModel;
const savedFallback = config.fallbackPlatforms;

after(() => {
  config.sttProvider = savedProvider;
  config.sttApiKey = savedApiKey;
  config.sttBaseUrl = savedBaseUrl;
  config.sttModel = savedModel;
  config.fallbackPlatforms = savedFallback;
});

describe("P3 語音轉文字（STT）", () => {
  it("provider=none 時明確報錯（不是靜默）", async () => {
    config.sttProvider = "none";
    await assert.rejects(
      transcribeAudio({ base64: "AAAA", mimeType: "audio/mp4" }, sttConfig()),
      /語音轉文字未啟用/,
    );
  });

  it("sttConfig：env 優先、缺則沿用全域 LLM", () => {
    config.sttProvider = "openai";
    config.sttApiKey = "sk-test-12345678";
    config.sttBaseUrl = "";
    config.sttModel = "";
    const cfg = sttConfig();
    assert.equal(cfg.provider, "openai");
    assert.equal(cfg.apiKey, "sk-test-12345678");
    assert.equal(cfg.model, "whisper-1", "未指定時用預設模型");
    assert.ok(cfg.baseUrl.length > 0);
  });

  it("openai：multipart 送出並解析 text", async () => {
    const savedFetch = globalThis.fetch;
    let seenUrl = "";
    let seenBody: FormData | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenBody = init?.body as FormData;
      return new Response(JSON.stringify({ text: "今天天氣如何" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const cfg: SttConfig = {
        provider: "openai",
        apiKey: "sk-test-12345678",
        baseUrl: "https://api.openai.com/v1",
        model: "whisper-1",
        timeoutMs: 5000,
        language: "",
        localBin: "",
      };
      const text = await transcribeAudio({ base64: "QUJD", mimeType: "audio/mp4" }, cfg);
      assert.equal(text, "今天天氣如何");
      assert.ok(seenUrl.includes("/audio/transcriptions"));
      assert.ok(seenBody instanceof FormData);
      assert.ok(seenBody.get("model"));
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("gemini：inline_data 送出並解析候選文字", async () => {
    const savedFetch = globalThis.fetch;
    let seenBody: unknown = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "語音內容" }] } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const cfg: SttConfig = {
        provider: "gemini",
        apiKey: "key-12345678",
        baseUrl: "https://generativelanguage.googleapis.com",
        model: "gemini-2.0-flash",
        timeoutMs: 5000,
        language: "zh",
        localBin: "",
      };
      const text = await transcribeAudio({ base64: "QUJD", mimeType: "audio/mp4" }, cfg);
      assert.equal(text, "語音內容");
      const body = seenBody as { contents?: Array<{ parts?: Array<{ inline_data?: { data?: string } }> }> };
      assert.equal(body.contents?.[0]?.parts?.[0]?.inline_data?.data, "QUJD");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("失敗有明確訊息（HTTP 錯誤帶狀態碼）", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    try {
      const cfg: SttConfig = {
        provider: "openai",
        apiKey: "sk-test-12345678",
        baseUrl: "https://api.openai.com/v1",
        model: "whisper-1",
        timeoutMs: 5000,
        language: "",
        localBin: "",
      };
      await assert.rejects(transcribeAudio({ base64: "QUJD", mimeType: "audio/mp4" }, cfg), /HTTP 503/);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe("P3 群組 @", () => {
  it("各平台的 @ 格式", () => {
    assert.equal(mentionPrefix("line", ["Neal"]), "@Neal ");
    assert.equal(mentionPrefix("telegram", ["neal"]), "@neal ");
    assert.equal(mentionPrefix("discord", ["123"]), "<@123> ");
    assert.equal(mentionPrefix("teams", ["Neal"]), "<at>Neal</at> ");
    assert.equal(mentionPrefix("line", []), "");
    assert.equal(mentionPrefix("line", undefined), "");
    assert.equal(mentionPrefix("telegram", ["@already"]), "@already ");
  });

  it("withMentions：文字前加 @、沒 mention 原樣", () => {
    assert.equal(withMentions("line", "早安", ["Neal"]), "@Neal 早安");
    assert.equal(withMentions("line", "早安", []), "早安");
    assert.equal(withMentions("discord", "hi", ["1", "2"]), "<@1> <@2> hi");
  });
});

describe("P3 跨平台備援順序", () => {
  it("依設定順序、排除目前平台、只認已知平台", () => {
    config.fallbackPlatforms = ["telegram", "line", "bogus"];
    const order = fallbackOrder("line");
    assert.deepEqual(order, ["telegram"]);
    config.fallbackPlatforms = ["telegram", "whatsapp"];
    assert.deepEqual(fallbackOrder("telegram"), ["whatsapp"]);
  });
});

describe("P3 跨平台備援行為", () => {
  it("主平台成功 → 不碰備援", async () => {
    config.fallbackPlatforms = ["telegram"];
    let called = false;
    const used = await sendWithFallback("line", "c1", "早安", "Neal", async () => {
      called = true;
    });
    assert.equal(called, true);
    assert.equal(used, "line");
  });

  it("主平台失敗且沒有備援目標 → 原樣拋回（失敗不會被吃掉）", async () => {
    config.fallbackPlatforms = ["telegram"];
    await assert.rejects(
      sendWithFallback("line", "c1", "早安", "找得到的名字", async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
  });
});
