import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWeekly } from "../src/skills/weather/index.js";
import weatherSkill from "../src/skills/weather/index.js";
import { config } from "../src/config.js";
import { rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import type { SkillContext } from "../src/skills/types.js";

describe("weather parseWeekly", () => {
  it("解析 open-meteo daily", () => {
    const days = parseWeekly({
      daily: {
        time: ["2026-10-12", "2026-10-13", "2026-10-14"],
        temperature_2m_max: [30.4, 31.1, 29.8],
        temperature_2m_min: [24.2, 25.0, 23.9],
        precipitation_probability_max: [20, 80, 10],
        weathercode: [0, 61, 3],
      },
    });
    assert.equal(days.length, 3);
    assert.equal(days[0].maxC, 30.4);
    assert.equal(days[0].pop, 20);
    assert.equal(days[0].desc, "晴");
    assert.equal(days[1].desc, "雨");
    assert.equal(days[2].desc, "多雲");
  });

  it("缺欄位不爆、以 time 長度為準", () => {
    const days = parseWeekly({ daily: { time: ["2026-10-12"] } });
    assert.equal(days.length, 1);
    assert.ok(Number.isNaN(days[0].maxC));
    assert.equal(days[0].pop, 0);
  });

  it("完全沒資料回空陣列", () => {
    assert.deepEqual(parseWeekly({}), []);
    assert.deepEqual(parseWeekly(null), []);
  });
});

describe("weather run()：雷達與一週（fetch stub）", () => {
  const realFetch = globalThis.fetch;
  const savedCache = process.env.CACHE_PATH;
  let dir = "";
  const seen: string[] = [];

  beforeEach(() => {
    seen.length = 0;
    dir = mkdtempSync(join(tmpdir(), "weather-run-"));
    process.env.CACHE_PATH = join(dir, "cache");
    // 雷達圖快取寫在 config.cachePath（import 時決定，不受 env 影響）；
    // 為了快取行為可預測，每個測試都先清掉舊檔。
    rmSync(joinPath(config.cachePath, "weather", "radar.png"), { force: true });
    const jsonRes = (obj: unknown): Response =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        arrayBuffer: async () => {
          const buf = Buffer.from(JSON.stringify(obj), "utf8");
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
      }) as unknown as Response;
    const bytesRes = (): Response =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "image/png" }),
        arrayBuffer: async () => {
          const buf = Buffer.alloc(2048, 1);
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
      }) as unknown as Response;

    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      seen.push(u);
      if (u.includes("open-meteo.com")) {
        return jsonRes({
          daily: {
            time: ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"],
            temperature_2m_max: [30, 31, 29, 28, 30, 31, 32],
            temperature_2m_min: [24, 25, 24, 23, 24, 25, 26],
            precipitation_probability_max: [10, 20, 30, 40, 50, 60, 70],
            weathercode: [0, 1, 2, 3, 61, 80, 95],
          },
        });
      }
      if (u.includes("cwa.gov.tw")) return bytesRes();
      return { ok: false, status: 404, text: async () => "" } as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedCache === undefined) delete process.env.CACHE_PATH;
    else process.env.CACHE_PATH = savedCache;
    rmSync(dir, { recursive: true, force: true });
  });

  function harness(replies: string[], images: string[]): SkillContext {
    return {
      text: "",
      args: "",
      fromName: "tester",
      chat: "c1",
      fromMid: "u1",
      config: {},
      reply: async (t: string) => {
        replies.push(t);
      },
      sendImage: async (source: string) => {
        images.push(source);
      },
      sendFile: async () => {},
      schedule: () => "s",
      watch: () => "w",
      unwatch: () => true,
      watches: () => [],
      taskState: () => undefined,
    } as unknown as SkillContext;
  }

  it("「天氣 一週 台北」組出七日預覽", async () => {
    const replies: string[] = [];
    const images: string[] = [];
    await weatherSkill.run({ ...harness(replies, images), args: "一週 台北" });
    assert.match(replies[0], /台北 一週天氣/);
    // 七天各一行（用星期標記數行數，避免項目符號重複計數）
    assert.equal((replies[0].match(/（[日一二三四五六]）/g) ?? []).length, 7);
    assert.match(replies[0], /28°/);
    assert.match(replies[0], /雨 40%/);
    assert.ok(seen.some((u) => u.includes("forecast_days=7")));
  });

  it("「天氣 一週 火星」明確報錯並列可支援城市", async () => {
    const replies: string[] = [];
    const images: string[] = [];
    await weatherSkill.run({ ...harness(replies, images), args: "一週 火星" });
    assert.match(replies[0], /查無「火星」/);
    assert.match(replies[0], /目前僅支援台灣/);
    assert.equal(seen.length, 0, "不該打任何 API");
  });

  it("「天氣 雷達」下載後送本地圖，第二次重用快取", async () => {
    const replies: string[] = [];
    const images: string[] = [];
    await weatherSkill.run({ ...harness(replies, images), args: "雷達" });
    assert.match(replies[0], /雷達回波圖/);
    assert.match(images[0], /radar\.png$/);
    const first = seen.filter((u) => u.includes("cwa.gov.tw")).length;
    assert.equal(first, 1);

    // 第二次：快取未過期，不再打 CWA
    await weatherSkill.run({ ...harness(replies, images), args: "雷達" });
    assert.equal(seen.filter((u) => u.includes("cwa.gov.tw")).length, 1);
  });

  it("雷達下載失敗時用明確訊息（不噴錯）", async () => {
    // 先清掉共用快取，確保這次真的走「下載失敗」分支
    rmSync(joinPath(config.cachePath, "weather", "radar.png"), { force: true });
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("cwa.gov.tw")) return { ok: false, status: 403, text: async () => "" } as Response;
      return { ok: false, status: 404, text: async () => "" } as Response;
    }) as typeof fetch;
    const replies: string[] = [];
    const images: string[] = [];
    await weatherSkill.run({ ...harness(replies, images), args: "雷達" });
    assert.match(replies[0], /暫時無法取得/);
    assert.equal(images.length, 0);
  });
});
