import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { config } from "../src/config.js";
import { dispatchIncoming, findNaturalIntent, scoreNaturalIntent, type DispatchDeps } from "../src/messaging/dispatch.js";
import { loadSkills } from "../src/skills/loader.js";

await loadSkills();

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

const savedSkills = [...config.skills];
const savedCache = config.cachePath;
beforeEach(() => {
  config.commands = { enabled: false, prefix: "!", allowFrom: [] };
  config.forward = [];
});
afterEach(() => {
  config.skills = [...savedSkills];
  config.cachePath = savedCache;
  globalThis.fetch = savedFetch;
});

const savedFetch = globalThis.fetch;
const msg = (text: string, extra: Record<string, unknown> = {}) => ({
  chat: "U_natural_user",
  fromId: "u1",
  fromName: "tester",
  chatName: "",
  text,
  ...extra,
});
const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id, enabled: true, trigger: "", allowedUsers: [], config: {}, ...extra,
});

describe("scoreNaturalIntent", () => {
  it("命中長度加總、去重、大小寫不敏感、重疊不重複計", () => {
    assert.equal(scoreNaturalIntent("台北天氣如何", ["天氣如何", "天氣"]), 4);
    assert.equal(scoreNaturalIntent("台積電", ["台積電", "台積"]), 3);
    assert.equal(scoreNaturalIntent("YOUBIKE 台北車站", ["YouBike", "ubike"]), 7);
    assert.equal(scoreNaturalIntent("今天天氣不錯", ["天氣如何"]), 0);
    assert.equal(scoreNaturalIntent("x", undefined), 0);
    assert.equal(scoreNaturalIntent("x", []), 0);
  });
});

describe("findNaturalIntent", () => {
  it("個人對話達 4 分命中", () => {
    config.skills = [entry("weather")];
    assert.equal(findNaturalIntent("台北天氣如何", "U_natural_user", "u1", "line")?.id, "weather");
  });

  it("未達門檻不命中（閒聊不劫持）", () => {
    config.skills = [entry("weather")];
    assert.equal(findNaturalIntent("台北天氣", "U_natural_user", "u1", "line"), null);
    assert.equal(findNaturalIntent("天氣不錯", "U_natural_user", "u1", "line"), null);
  });

  it("群組門檻 6 分", () => {
    config.skills = [entry("weather")];
    assert.equal(findNaturalIntent("會下雨嗎", "C_natural_group", "u1", "line"), null);
    assert.equal(findNaturalIntent("台北天氣如何", "C_natural_group", "u1", "line"), null);
    assert.equal(findNaturalIntent("台北天氣如何會下雨嗎", "C_natural_group", "u1", "line")?.id, "weather");
  });

  it("最高分同分不觸發（即使達門檻）", () => {
    config.skills = [entry("weather"), entry("outage")];
    assert.equal(findNaturalIntent("天氣如何停水了嗎", "U_natural_user", "u1", "line"), null);
  });

  it("停用與白名單不符略過", () => {
    config.skills = [entry("weather", { enabled: false })];
    assert.equal(findNaturalIntent("台北天氣如何", "U_natural_user", "u1", "line"), null);
    config.skills = [entry("weather", { allowedUsers: ["boss"] })];
    assert.equal(findNaturalIntent("台北天氣如何", "U_natural_user", "u1", "line"), null);
    config.skills = [entry("weather", { allowedUsers: ["u1"] })];
    assert.equal(findNaturalIntent("台北天氣如何", "U_natural_user", "u1", "line")?.id, "weather");
  });

  it("公司名＋股價直達股價技能；單獨公司名不觸發", () => {
    config.skills = [entry("stock")];
    assert.equal(findNaturalIntent("台積電股價", "U_natural_user", "u1", "line")?.id, "stock");
    assert.equal(findNaturalIntent("台積電", "U_natural_user", "u1", "line"), null);
    assert.equal(findNaturalIntent("我買了台積電", "U_natural_user", "u1", "line"), null);
  });
});

describe("無前綴自然意圖 E2E", () => {
  it("台北天氣如何直達天氣技能", async () => {
    const d = makeDeps();
    config.skills = [entry("weather")];
    config.cachePath = mkdtempSync(join(tmpdir(), "natural-e2e-"));
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ current_condition: [{ temp_C: "25", FeelsLikeC: "28", humidity: "84", weatherDesc: [{ value: "晴" }] }] }),
      )) as typeof fetch;
    await dispatchIncoming(msg("台北天氣如何", { messageId: "natural-e2e-1" }), d);
    assert.equal(d.replies.length, 1);
    assert.match(d.replies[0], /台北 天氣/);
  });

  it("閒聊不觸發技能", async () => {
    const d = makeDeps();
    config.skills = [entry("weather")];
    await dispatchIncoming(msg("台北天氣真好", { messageId: "natural-e2e-2" }), d);
    assert.deepEqual(d.replies, []);
  });
});
