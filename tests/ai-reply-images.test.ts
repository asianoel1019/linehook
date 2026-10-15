import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_PROGRESS_AFTER_MS, aiProgressText, findReplyImages, sendReplyImages } from "../src/skills/ai/index.js";
import aiSkill from "../src/skills/ai/index.js";
import type { SkillContext } from "../src/skills/types.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "replyimg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makePng(name: string, bytes = 100): string {
  const p = join(dir, name);
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(p, Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length))]));
  return p;
}

describe("findReplyImages", () => {
  it("抽出 Unix 路徑並剝掉結尾標點（含中文標點與括號引號）", () => {
    const a = makePng("a.png");
    const b = makePng("b.png");
    const found = findReplyImages(`圖在這：${a}。另一張 ${b}, 還有 "${b}" 跟(${a}) 結尾`, { roots: [dir] });
    assert.deepEqual(
      found.map((f) => f.path).sort(),
      [a, b].sort(),
      "重複與標點都要處理，只回不重複的兩張",
    );
    assert.ok(found.every((f) => f.dataUrl.startsWith("data:image/png;base64,")));
    assert.equal(found.find((f) => f.path === a)?.filename, "a.png");
  });

  it("不存在、非圖片副檔名、目錄外、超大都不收", () => {
    const good = makePng("good.png");
    const big = makePng("big.png", 5000);
    writeFileSync(join(dir, "note.txt"), "hello");
    const outside = join(tmpdir(), "replyimg-outside.png");
    writeFileSync(outside, Buffer.alloc(100));
    try {
      const text = `A ${good} B /no/such/file.png C ${join(dir, "note.txt")} D ${outside} E ${big} F ${good}`;
      const found = findReplyImages(text, { roots: [dir], maxBytes: 1000, maxCount: 10 });
      assert.deepEqual(found.map((f) => f.path), [good]);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("超過 maxCount 只取前 N 張", () => {
    const files = [makePng("1.png"), makePng("2.png"), makePng("3.png")];
    const found = findReplyImages(files.join(" "), { roots: [dir], maxCount: 2 });
    assert.equal(found.length, 2);
  });
});

describe("sendReplyImages", () => {
  function mockCtx(events: string[], failOn: string[] = []): SkillContext {
    return {
      sendImage: async (source: string, filename?: string) => {
        if (failOn.includes(filename ?? "")) throw new Error("send boom");
        events.push(`image:${filename ?? ""}:${typeof source === "string" && source.startsWith("data:")}`);
      },
      reply: async (t: string) => {
        events.push(`reply:${t.slice(0, 6)}`);
      },
    } as unknown as SkillContext;
  }

  it("有圖就送、無圖回 0；單張失敗不擋其他", async () => {
    const a = makePng("a.png");
    const b = makePng("b.png");
    const events: string[] = [];
    const ctx = mockCtx(events, ["b.png"]);
    const n = await sendReplyImages(ctx, `看圖 ${a} 和 ${b}`);
    assert.equal(n, 1);
    assert.deepEqual(events, ["image:a.png:true"]);
    const n0 = await sendReplyImages(mockCtx(events), "今天天氣不錯，沒有圖片");
    assert.equal(n0, 0);
  });
});

describe("aiProgressText", () => {
  it("第 1 分鐘不帶數字，之後帶分鐘數", () => {
    assert.equal(aiProgressText(1), "詢問中請稍後…");
    assert.equal(aiProgressText(2), "詢問中請稍後…（已等待2分鐘）");
    assert.equal(AI_PROGRESS_AFTER_MS, 60_000);
  });
});

describe("ai 慢回覆每分鐘報平安", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    mock.timers.reset();
    globalThis.fetch = realFetch;
  });

  it("60 秒內無事；每滿 1 分鐘一則；答完即停", async () => {
    mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: Date.now() });
    let resolveFetch: ((v: unknown) => void) | undefined;
    globalThis.fetch = (() =>
      new Promise((res) => {
        resolveFetch = res as (v: unknown) => void;
      })) as unknown as typeof fetch;

    const events: string[] = [];
    const runP = aiSkill.run({
      text: "慢慢想",
      args: "慢慢想",
      fromName: "小明",
      chat: "c-slow",
      fromMid: "u1",
      config: {
        provider: "openai",
        baseUrl: "https://api.test/v1",
        apiKey: "k",
        model: "gpt-test",
        tools: "off",
        memory: "off",
        timeoutMs: "3600000",
      },
      reply: async (t: string) => {
        events.push(`reply:${t}`);
      },
      sendImage: async () => {},
      sendFile: async () => {},
      schedule: () => "",
      watch: () => "",
      unwatch: () => true,
      watches: () => [],
      taskState: () => undefined,
    });

    mock.timers.tick(59_000);
    assert.deepEqual(events, []);
    mock.timers.tick(1_000);
    assert.deepEqual(events, ["reply:詢問中請稍後…"]);
    mock.timers.tick(60_000);
    assert.deepEqual(events, ["reply:詢問中請稍後…", "reply:詢問中請稍後…（已等待2分鐘）"]);

    const res = resolveFetch;
    assert.ok(res, "fetch executor 應已執行");
    res({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ choices: [{ message: { content: "想好了" } }], usage: {} }),
      text: async () => "{}",
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await runP;
    assert.deepEqual(events, ["reply:詢問中請稍後…", "reply:詢問中請稍後…（已等待2分鐘）", "reply:想好了"]);
    mock.timers.tick(120_000);
    assert.equal(events.length, 3, "答完後不再報平安");
  });
});

describe("ai 技能回覆圖片自動傳送（順序：先圖後文）", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("模型回覆提到本機圖檔 → 先 sendImage 再 reply", async () => {
    const pic = makePng("pic.png");
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ choices: [{ message: { content: `畫好了，檔案在 ${pic} 請看` } }], usage: {} }),
      text: async () => "{}",
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;

    const events: string[] = [];
    await aiSkill.run({
      text: "畫一張圖",
      args: "畫一張圖",
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
      reply: async (t: string) => {
        events.push(`reply:${t.includes("畫好了")}`);
      },
      sendImage: async (_source: string, filename?: string) => {
        events.push(`image:${filename ?? ""}`);
      },
      sendFile: async () => {},
      schedule: () => "",
      watch: () => "",
      unwatch: () => true,
      watches: () => [],
      taskState: () => undefined,
    });
    assert.deepEqual(events, ["image:pic.png", "reply:true"]);
  });
});
