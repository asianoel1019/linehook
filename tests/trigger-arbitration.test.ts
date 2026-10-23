import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { config } from "../src/config.js";
import {
  dispatchIncoming,
  findTriggerConflicts,
  scanTriggerHits,
  selectTriggerHit,
  analyzeAssistantPrefix,
  type DispatchDeps,
  type TriggerHit,
} from "../src/messaging/dispatch.js";
import { loadSkills } from "../src/skills/loader.js";
import { listSkills, getSkill } from "../src/skills/index.js";
import { simulateDispatch } from "../src/messaging/simulate.js";

await loadSkills();

const savedSkills = [...config.skills];
const savedAssistant = { ...config.assistant };
const savedCache = config.cachePath;
const savedFetch = globalThis.fetch;

beforeEach(() => {
  config.assistant = { enabled: true, name: "阿寶" };
  config.commands = { enabled: false, prefix: "!", allowFrom: [] };
  config.forward = [];
});

afterEach(() => {
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
  chat: "c-trigger",
  fromId: "u1",
  fromName: "tester",
  chatName: "",
  text,
  ...extra,
});

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id, enabled: true, trigger: "", allowedUsers: [], config: {}, ...extra,
});

const hit = (skillId: string, trigger: string): TriggerHit => ({
  skill: entry(skillId),
  def: undefined as never,
  trigger,
  args: "",
  usage: false,
});

describe("selectTriggerHit", () => {
  it("最長勝出；同長取順序第一；空回 null", () => {
    assert.equal(selectTriggerHit([hit("remind", "倒數"), hit("countdown", "倒數計時")])?.skill.id, "countdown");
    assert.equal(selectTriggerHit([hit("countdown", "倒數計時"), hit("remind", "倒數")])?.skill.id, "countdown");
    assert.equal(selectTriggerHit([hit("a", "換算"), hit("b", "換算")])?.skill.id, "a");
    assert.equal(selectTriggerHit([]), null);
  });
});

describe("scanTriggerHits", () => {
  it("prefix 命中進 prefixHits；any 進 anyHits；停用略過、白名單另記", () => {
    config.skills = [
      entry("weather"),
      entry("auto-reply", { config: { rules: JSON.stringify([{ keyword: "zzz-no-match" }]) } }),
      entry("ghost"),
      entry("stock", { enabled: false }),
      entry("quake", { allowedUsers: ["boss"] }),
    ];
    assert.ok(getSkill("auto-reply"));
    assert.ok(getSkill("weather"));
    const prefix = analyzeAssistantPrefix("阿寶請幫忙 天氣 台北", "阿寶", "zh");
    const scan = scanTriggerHits(
      config.skills,
      { text: "阿寶請幫忙 天氣 台北", chat: "c-trigger", fromMid: "u1" },
      prefix,
      true,
    );
    assert.deepEqual(scan.prefixHits.map((h) => h.skill.id), ["weather"]);
    assert.deepEqual(scan.anyHits.map((h) => h.skill.id), ["auto-reply"]);
    assert.deepEqual(scan.blocked.map((s) => s.id), ["quake"]);
  });
});

describe("findTriggerConflicts", () => {
  it("完全相同", () => {
    assert.deepEqual(findTriggerConflicts([
      { id: "a", enabled: true, words: ["換算"] },
      { id: "b", enabled: true, words: ["換算"] },
    ]), [{ word: "換算", kind: "exact", owners: ["a", "b"] }]);
  });

  it("互為前綴（長短不拘）", () => {
    assert.deepEqual(findTriggerConflicts([
      { id: "remind", enabled: true, words: ["倒數"] },
      { id: "countdown", enabled: true, words: ["倒數計時"] },
    ]), [{ word: "倒數計時", kind: "prefix", owners: ["countdown", "remind"] }]);
  });

  it("停用、空詞、同一技能內部不算", () => {
    assert.deepEqual(findTriggerConflicts([
      { id: "a", enabled: false, words: ["換算"] },
      { id: "b", enabled: true, words: ["換算", ""] },
    ]), []);
    assert.deepEqual(findTriggerConflicts([
      { id: "a", enabled: true, words: ["KFC", "kfc"] },
      { id: "b", enabled: true, words: ["麥當勞"] },
    ]), []);
  });
});

describe("P0 E2E：撞車與遮蔽", () => {
  it("倒數計時歸 countdown（remind 排前面也一樣）", async () => {
    const d = makeDeps();
    config.skills = [entry("remind"), entry("countdown")];
    await dispatchIncoming(msg("阿寶請幫忙 倒數計時 每年 5/20 測試", { messageId: "arb-1" }), d);
    assert.equal(d.replies.length, 1);
    assert.match(d.replies[0], /已紀錄|每年/);
  });

  it("換算只回一次（順序第一者勝）", async () => {
    const d = makeDeps();
    config.skills = [entry("exchange-rate"), entry("unit")];
    await dispatchIncoming(msg("阿寶請幫忙 換算 1 km", { messageId: "arb-2" }), d);
    assert.equal(d.replies.length, 1);
    assert.match(d.replies[0], /用法|匯率/);
  });

  it("順序反轉則 unit 勝", async () => {
    const d = makeDeps();
    config.skills = [entry("unit"), entry("exchange-rate")];
    await dispatchIncoming(msg("阿寶請幫忙 換算 100 公分 公尺", { messageId: "arb-3" }), d);
    assert.equal(d.replies.length, 1);
    assert.match(d.replies[0], /公尺/);
    assert.doesNotMatch(d.replies[0], /匯率|用法/);
  });

  it("any 模式不受仲裁影響（照舊可並存）", async () => {
    const d = makeDeps();
    config.cachePath = mkdtempSync(join(tmpdir(), "arb-"));
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ current_condition: [{ temp_C: "25", FeelsLikeC: "28", humidity: "84", weatherDesc: [{ value: "晴" }] }] }),
      )) as typeof fetch;
    config.skills = [
      entry("auto-reply", { config: { cooldownSec: "0", rules: JSON.stringify([{ keyword: "台北", match: "contains", text: "收到" }]) } }),
      entry("weather"),
    ];
    await dispatchIncoming(msg("阿寶請幫忙 天氣 台北", { messageId: "arb-4" }), d);
    assert.equal(d.replies.length, 2);
  });

  it("被白名單擋下的技能不參選，其餘照常執行", async () => {
    const d = makeDeps();
    config.skills = [entry("exchange-rate", { allowedUsers: ["boss"] }), entry("unit")];
    await dispatchIncoming(msg("阿寶請幫忙 換算 1 km", { messageId: "arb-5" }), d);
    assert.equal(d.replies.length, 1);
    assert.match(d.replies[0], /來源單位/);
  });
});

describe("全技能觸發自保（每個觸發詞都歸自己）", () => {
  it("全部內建技能逐一驗證（已知重複組只斷言唯一勝出者）", () => {
    config.skills = listSkills().map((d) => entry(d.id));
    // 觸發詞完全重複的組：勝出者必須是其中之一（順序第一），且只能有一個
    const dupGroups: string[][] = [["exchange-rate", "unit"], ["rss", "summarize"]];
    const failures: string[] = [];
    for (const def of listSkills()) {
      if (def.triggerMode === "any") continue;
      const primary = def.defaultTrigger.trim();
      if (!primary) continue;
      const text = `阿寶請幫忙 ${primary} x`;
      const prefix = analyzeAssistantPrefix(text, "阿寶", "zh");
      const scan = scanTriggerHits(
        config.skills,
        { text, chat: "c-trigger", fromMid: "u1" },
        prefix,
        true,
      );
      const winner = selectTriggerHit(scan.prefixHits);
      if (!winner) {
        failures.push(`${def.id}：無人命中「${primary}」`);
        continue;
      }
      const group = dupGroups.find((g) => g.includes(def.id));
      if (group) {
        if (!group.includes(winner.skill.id)) {
          failures.push(`${def.id}：勝出者 ${winner.skill.id} 不在重複組內`);
        }
        continue;
      }
      if (winner.skill.id !== def.id) {
        failures.push(`${def.id}：被 ${winner.skill.id}（${winner.trigger}）攔走`);
      }
    }
    assert.deepEqual(failures, []);
  });
});

describe("模擬器顯示仲裁", () => {
  it("多命中時多一條仲裁 stage", () => {
    config.skills = [entry("remind"), entry("countdown")];
    const r = simulateDispatch({
      text: "阿寶請幫忙 倒數計時 每年 5/20 測試",
      chat: "c",
      fromId: "u1",
      fromName: "t",
      chatName: "",
    });
    const arb = r.stages.filter((s) => s.label === "仲裁");
    assert.equal(arb.length, 1);
    assert.match(arb[0].detail, /countdown/);
  });
});
