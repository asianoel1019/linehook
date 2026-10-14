import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  analyzeAssistantPrefix,
  commandAllowed,
  matchForwardRule,
  matchSkillEntry,
  parseCommandInput,
} from "../src/messaging/dispatch.js";
import { renderSimulation, simulateDispatch } from "../src/messaging/simulate.js";
import type { SkillDefinition } from "../src/skills/types.js";
import { loadSkills } from "../src/skills/loader.js";
import autoReplySkill, { resolveAutoReply } from "../src/skills/auto-reply/index.js";

// 整合測試需要真的技能定義（getSkill 才有東西）
await loadSkills();

/* ---------- 純函式：助理前綴 ---------- */

describe("analyzeAssistantPrefix", () => {
  it("中文禮貌詞會被剝掉", () => {
    const p = analyzeAssistantPrefix("阿寶請幫忙 天氣 台北", "阿寶", "zh");
    assert.equal(p.hasPrefix, true);
    assert.equal(p.rest, "天氣 台北");
  });

  it("最多剝三層禮貌詞（第 4 層起保留）", () => {
    // 請幫忙 → 請幫 → 幫忙 三層後停在「忙天氣」
    const p = analyzeAssistantPrefix("阿寶請幫忙請幫幫忙忙天氣", "阿寶", "zh");
    assert.equal(p.rest, "忙天氣");
  });

  it("英文／日文禮貌詞各依語言", () => {
    assert.equal(analyzeAssistantPrefix("Abao please weather", "Abao", "en").rest, "weather");
    assert.equal(analyzeAssistantPrefix("アバオ お願い 天気", "アバオ", "ja").rest, "天気");
    // 中文部署下不吃英文禮貌詞
    assert.equal(analyzeAssistantPrefix("Abao please weather", "Abao", "zh").rest, "please weather");
  });

  it("沒有前綴或助理名為空", () => {
    const p = analyzeAssistantPrefix("天氣 台北", "阿寶", "zh");
    assert.equal(p.hasPrefix, false);
    assert.equal(p.rest, "");
    assert.equal(analyzeAssistantPrefix("hello", "", "zh").hasPrefix, false);
  });
});

/* ---------- 純函式：技能比對 ---------- */

const def = (over: Partial<SkillDefinition>): SkillDefinition =>
  ({
    id: "x",
    name: "X",
    description: "d",
    defaultTrigger: "天氣",
    fields: [],
    run: async () => {},
    ...over,
  }) as SkillDefinition;

const skillCfg = (over: Record<string, unknown> = {}) => ({
  id: "weather",
  enabled: true,
  trigger: "",
  allowedUsers: [],
  config: {},
  ...over,
});

describe("matchSkillEntry", () => {
  const msg = { text: "阿寶請幫忙 天氣 台北", chat: "c1", fromMid: "u1" };
  const prefix = analyzeAssistantPrefix(msg.text, "阿寶", "zh");

  it("命中助理模式技能，帶出參數", () => {
    const d = matchSkillEntry(skillCfg(), def({ id: "weather" }), msg, prefix, true);
    assert.equal(d.outcome, "hit");
    assert.equal(d.trigger, "天氣");
    assert.equal(d.args, "台北");
  });

  it("別名也可命中", () => {
    const d = matchSkillEntry(skillCfg(), def({ id: "weather", triggerAliases: ["氣溫"] }), msg, prefix, true);
    assert.equal(d.outcome, "hit");
  });

  it("觸發詞不同就 miss", () => {
    const d = matchSkillEntry(skillCfg({ id: "rss" }), def({ id: "rss", defaultTrigger: "rss" }), msg, prefix, true);
    assert.equal(d.outcome, "miss");
    assert.match(d.reason ?? "", /觸發詞不符/);
  });

  it("any 模式不要求前綴", () => {
    const d = matchSkillEntry(
      skillCfg({ id: "auto-reply" }),
      def({ id: "auto-reply", defaultTrigger: "", triggerMode: "any" }),
      { text: "隨便", chat: "c1", fromMid: "u1" },
      analyzeAssistantPrefix("隨便", "阿寶", "zh"),
      true,
    );
    assert.equal(d.outcome, "hit");
    assert.equal(d.args, "隨便");
  });

  it("停用／無定義／白名單擋下", () => {
    assert.equal(matchSkillEntry(skillCfg({ enabled: false }), def({}), msg, prefix, true).outcome, "skip-disabled");
    assert.equal(matchSkillEntry(skillCfg(), undefined, msg, prefix, true).outcome, "skip-no-def");
    assert.equal(
      matchSkillEntry(skillCfg({ allowedUsers: ["boss"] }), def({}), msg, prefix, true).outcome,
      "blocked-users",
    );
  });

  it("未開助理／沒有前綴各自 miss", () => {
    assert.equal(matchSkillEntry(skillCfg(), def({}), msg, prefix, false).outcome, "miss");
    const noPrefix = analyzeAssistantPrefix("天氣 台北", "阿寶", "zh");
    assert.equal(matchSkillEntry(skillCfg(), def({}), msg, noPrefix, true).outcome, "miss");
  });

  it("只喊助理名（rest 為空）miss", () => {
    const onlyName = analyzeAssistantPrefix("阿寶請幫忙", "阿寶", "zh");
    const d = matchSkillEntry(skillCfg(), def({}), msg, onlyName, true);
    assert.equal(d.outcome, "miss");
    assert.match(d.reason ?? "", /助理名稱/);
  });

  it("Layer 2：觸發詞＋問號", () => {
    const m = { text: "阿寶請幫忙 天氣 ?", chat: "c1", fromMid: "u1" };
    const d = matchSkillEntry(skillCfg(), def({}), m, analyzeAssistantPrefix(m.text, "阿寶", "zh"), true);
    assert.equal(d.outcome, "layer2-usage");
    assert.equal(d.trigger, "天氣");
  });

  it("設定裡自訂觸發詞優先於預設", () => {
    const m = { text: "阿寶請幫忙 氣象 台北", chat: "c1", fromMid: "u1" };
    const d = matchSkillEntry(
      skillCfg({ trigger: "氣象" }),
      def({}),
      m,
      analyzeAssistantPrefix(m.text, "阿寶", "zh"),
      true,
    );
    assert.equal(d.outcome, "hit");
    assert.equal(d.trigger, "氣象");
  });
});

/* ---------- 純函式：指令／轉發 ---------- */

describe("parseCommandInput / commandAllowed", () => {
  it("解析指令與參數", () => {
    assert.deepEqual(parseCommandInput("!send u1 hello", "!"), { command: "send", args: "u1 hello" });
    assert.deepEqual(parseCommandInput("!id", "!"), { command: "id", args: "" });
    assert.equal(parseCommandInput("hello", "!"), null);
  });

  it("自訂前綴", () => {
    assert.deepEqual(parseCommandInput("/id", "/"), { command: "id", args: "" });
  });

  it("白名單", () => {
    assert.equal(commandAllowed("u1", "c1", []), true);
    assert.equal(commandAllowed("u1", "c1", ["u1"]), true);
    assert.equal(commandAllowed("u1", "c1", ["c1"]), true, "對話 ID 也可放行");
    assert.equal(commandAllowed("u1", "c1", ["other"]), false);
  });
});

describe("matchForwardRule", () => {
  const rule = (over: Record<string, unknown> = {}) => ({
    id: "r1",
    enabled: true,
    match: "contains" as const,
    keyword: "台北",
    source: "",
    target: "u9",
    includeSender: false,
    prefix: "",
    ...over,
  });

  it("contains 命中並推導轉發內容", () => {
    const r = matchForwardRule(rule(), "明天台北天氣", "c1", "群組", "小明");
    assert.equal(r.matched, true);
    assert.equal(r.forwarded, "明天台北天氣");
  });

  it("前綴＋含寄件者的預覽順序", () => {
    const r = matchForwardRule(rule({ includeSender: true, prefix: "[Fwd]" }), "台北", "c1", "群組", "小明");
    assert.equal(r.forwarded, "[Fwd] [群組] 台北");
  });

  it("all／空關鍵字 → 全部轉發（保留舊行為）", () => {
    assert.equal(matchForwardRule(rule({ match: "all", keyword: "" }), "什麼都轉", "c1", "", "").matched, true);
    assert.equal(matchForwardRule(rule({ keyword: "   " }), "也轉", "c1", "", "").matched, true);
  });

  it("regex 壞掉不炸、只回未命中", () => {
    const r = matchForwardRule(rule({ match: "regex", keyword: "([" }), "test", "c1", "", "");
    assert.equal(r.matched, false);
    assert.match(r.reason, /正則/);
  });

  it("未啟用／來源不符／無目標", () => {
    assert.equal(matchForwardRule(rule({ enabled: false }), "台北", "c1", "", "").matched, false);
    assert.equal(matchForwardRule(rule({ source: "other" }), "台北", "c1", "", "").matched, false);
    assert.equal(matchForwardRule(rule({ target: "" }), "台北", "c1", "", "").matched, false);
  });

  it("多關鍵字以 | 分隔，任一即中", () => {
    assert.equal(matchForwardRule(rule({ keyword: "高雄|台北" }), "去高雄", "c1", "", "").matched, true);
    assert.equal(matchForwardRule(rule({ keyword: "高雄|台北" }), "去台中", "c1", "", "").matched, false);
  });
});

/* ---------- 整合：simulateDispatch ---------- */

const saved = {
  assistant: { ...config.assistant },
  commands: { ...config.commands, allowFrom: [...config.commands.allowFrom] },
  forward: [...config.forward],
  skills: [...config.skills],
  language: config.language,
};

beforeEach(() => {
  config.assistant = { enabled: true, name: "阿寶" };
  config.commands = { enabled: true, prefix: "!", allowFrom: [] };
  config.forward = [];
  config.skills = [];
  config.language = "zh";
});

afterEach(() => {
  config.assistant = { ...saved.assistant };
  config.commands = { ...saved.commands, allowFrom: [...saved.commands.allowFrom] };
  config.forward = [...saved.forward];
  config.skills = [...saved.skills];
  config.language = saved.language;
});

const baseInput = {
  text: "阿寶請幫忙 天氣 台北",
  chat: "c1",
  fromId: "u1",
  fromName: "小明",
  chatName: "群組",
};

interface SimulateStageLite {
  outcome: string;
  label: string;
  detail: string;
  preview?: string;
}

function stage(
  result: ReturnType<typeof simulateDispatch>,
  which: "dedup" | "command" | "skill" | "forward",
): SimulateStageLite[] {
  return result.stages.filter((s) => s.stage === which) as SimulateStageLite[];
}

describe("simulateDispatch 端到端", () => {
  it("空訊息給提示、不進任何流程", () => {
    const r = simulateDispatch({ ...baseInput, text: "   " });
    assert.equal(r.stages.length, 1);
    assert.match(r.stages[0].detail, /沒有文字內容/);
  });

  it("指令＋轉發命中；以指令開頭的訊息沒有助理前綴 → 助理技能 Miss", () => {
    config.skills = [
      { id: "weather", enabled: true, trigger: "", allowedUsers: [], config: {} },
      { id: "ghost", enabled: false, trigger: "", allowedUsers: [], config: {} },
    ];
    config.forward = [
      {
        id: "r1",
        enabled: true,
        match: "contains",
        keyword: "台北",
        source: "",
        target: "u9",
        includeSender: true,
        prefix: "[Fwd]",
      },
    ];
    const r = simulateDispatch({ ...baseInput, text: "!id 阿寶請幫忙 天氣 台北" });
    const cmd = stage(r, "command");
    const skills = stage(r, "skill");
    const fwd = stage(r, "forward");

    assert.equal(cmd[0].outcome, "hit");
    assert.match(cmd[0].label, /!id/);
    // 指令開頭的訊息沒有助理前綴 → 助理類技能 Miss（與真實管線一致）
    assert.equal(skills[0].outcome, "miss");
    assert.match(skills[0].detail, /助理名稱開頭/);
    assert.equal(skills[1].outcome, "skipped");
    assert.equal(fwd.length, 1);
    assert.equal(fwd[0].outcome, "hit");
    assert.equal(fwd[0].preview, "[Fwd] [群組] !id 阿寶請幫忙 天氣 台北");
  });

  it("any 模式技能＋轉發可與助理技能同時命中", () => {
    config.skills = [
      { id: "weather", enabled: true, trigger: "", allowedUsers: [], config: {} },
      {
        id: "auto-reply",
        enabled: true,
        trigger: "",
        allowedUsers: [],
        config: {
          cooldownSec: "0",
          rules: JSON.stringify([{ keyword: "天氣", match: "contains", text: "收到", enabled: true }]),
        },
      },
    ];
    config.forward = [
      {
        id: "r1",
        enabled: true,
        match: "contains",
        keyword: "台北",
        source: "",
        target: "u9",
        includeSender: false,
        prefix: "",
      },
    ];
    const r = simulateDispatch(baseInput);
    const skills = stage(r, "skill");
    assert.equal(skills.length, 2);
    assert.equal(skills[0].outcome, "hit");
    assert.match(skills[0].detail, /助理模式・觸發詞「天氣」/);
    // any 模式不看前綴，直接命中（自動回覆另有規則層級的細節）
    assert.equal(skills[1].outcome, "hit");
    assert.match(skills[1].detail, /命中規則「天氣」/);
    assert.equal(stage(r, "forward")[0].outcome, "hit");
  });

  it("Layer 1：只喊助理名就不再比對技能", () => {
    config.skills = [{ id: "weather", enabled: true, trigger: "", allowedUsers: [], config: {} }];
    const r = simulateDispatch({ ...baseInput, text: "阿寶請幫忙" });
    assert.equal(r.layer1, true);
    const skills = stage(r, "skill");
    assert.equal(skills.length, 1);
    assert.match(skills[0].detail, /技能清單/);
  });

  it("指令停用／非指令／白名單", () => {
    config.commands.enabled = false;
    assert.match(stage(simulateDispatch({ ...baseInput, text: "!id 阿寶請幫忙" }), "command")[0].detail, /未啟用/);

    config.commands.enabled = true;
    assert.equal(stage(simulateDispatch({ ...baseInput, text: "阿寶請幫忙 天氣" }), "command")[0].outcome, "miss");

    config.commands.allowFrom = ["boss"];
    assert.equal(stage(simulateDispatch({ ...baseInput, text: "!id" }), "command")[0].outcome, "blocked");
  });

  it("自動回覆：命中哪條規則說清楚", () => {
    config.skills = [
      {
        id: "auto-reply",
        enabled: true,
        trigger: "",
        allowedUsers: [],
        config: {
          cooldownSec: "60",
          rules: JSON.stringify([{ keyword: "報價", match: "contains", text: "請私訊我", enabled: true }]),
        },
      },
    ];
    const r = simulateDispatch({ ...baseInput, text: "請問報價" });
    const skills = stage(r, "skill");
    assert.equal(skills[0].outcome, "hit");
    assert.match(skills[0].detail, /命中規則「報價」/);
    assert.match(skills[0].detail, /請私訊我/);
    assert.doesNotMatch(skills[0].detail, /冷卻中/);
  });

  it("自動回覆沒有符合規則就 miss", () => {
    config.skills = [
      {
        id: "auto-reply",
        enabled: true,
        trigger: "",
        allowedUsers: [],
        config: { cooldownSec: "60", rules: JSON.stringify([{ keyword: "報價", enabled: true }]) },
      },
    ];
    const r = simulateDispatch({ ...baseInput, text: "你好" });
    assert.equal(stage(r, "skill")[0].outcome, "miss");
    assert.match(stage(r, "skill")[0].detail, /沒有符合/);
  });

  it("自動回覆真實冷卻中 → 模擬判 blocked", async () => {
    const chat = "cooldown-chat";
    config.skills = [
      {
        id: "auto-reply",
        enabled: true,
        trigger: "",
        allowedUsers: [],
        config: { cooldownSec: "60", rules: JSON.stringify([{ keyword: "報價", text: "私訊", enabled: true }]) },
      },
    ];
    // 先用真實 run() 回一次 → 模組內冷卻狀態被寫入
    await autoReplySkill.run({
      text: "報價",
      args: "報價",
      fromName: "小明",
      chat,
      fromMid: "u1",
      config: config.skills[0].config,
      reply: async () => {},
      sendImage: async () => {},
      sendFile: async () => {},
      schedule: () => "",
      watch: () => "",
      unwatch: () => true,
      watches: () => [],
      taskState: () => undefined,
    });

    const r = simulateDispatch({ ...baseInput, chat, text: "報價" });
    const skills = stage(r, "skill");
    assert.equal(skills[0].outcome, "blocked");
    assert.match(skills[0].detail, /冷卻中/);
    assert.match(skills[0].detail, /實際不會送出/);
  });

  it("冷卻判定用真實時間：now 被平移也不影響（UTC 機器上 nowInTz 回假 epoch）", async () => {
    const chat = "tz-shift-chat";
    const skillConfig = {
      cooldownSec: "60",
      rules: JSON.stringify([{ keyword: "報價", text: "私訊", enabled: true }]),
    };
    config.skills = [{ id: "auto-reply", enabled: true, trigger: "", allowedUsers: [], config: skillConfig }];
    await autoReplySkill.run({
      text: "報價",
      args: "報價",
      fromName: "小明",
      chat,
      fromMid: "u1",
      config: skillConfig,
      reply: async () => {},
      sendImage: async () => {},
      sendFile: async () => {},
      schedule: () => "",
      watch: () => "",
      unwatch: () => true,
      watches: () => [],
      taskState: () => undefined,
    });

    // 直接傳一個平移 +8 小時的 now（等同 UTC 機器上 nowInTz() 的 getTime），冷卻照樣要命中
    const shiftedNow = new Date(Date.now() + 8 * 3600 * 1000);
    const d = resolveAutoReply(skillConfig, "報價", chat, "u1", shiftedNow);
    assert.equal(d.outcome, "blocked");
  });

  it("模擬不改變冷卻狀態（重複模擬結果一致）", () => {
    config.skills = [
      {
        id: "auto-reply",
        enabled: true,
        trigger: "",
        allowedUsers: [],
        config: { cooldownSec: "60", rules: JSON.stringify([{ keyword: "報價", text: "私訊", enabled: true }]) },
      },
    ];
    const a = simulateDispatch(baseInput);
    const b = simulateDispatch(baseInput);
    assert.deepEqual(a.stages, b.stages);
  });

  it("轉發規則都沒命中／沒有規則", () => {
    config.forward = [
      {
        id: "r1",
        enabled: true,
        match: "contains",
        keyword: "不存在",
        source: "",
        target: "u9",
        includeSender: false,
        prefix: "",
      },
    ];
    const miss = simulateDispatch(baseInput);
    assert.equal(stage(miss, "forward")[0].outcome, "miss");
    assert.match(stage(miss, "forward")[0].detail, /未命中/);

    config.forward = [];
    assert.match(stage(simulateDispatch(baseInput), "forward")[0].detail, /沒有設定轉發規則/);
  });

  it("壞 regex 的轉發規則不會炸掉模擬", () => {
    config.forward = [
      {
        id: "bad",
        enabled: true,
        match: "regex",
        keyword: "([",
        source: "",
        target: "u9",
        includeSender: false,
        prefix: "",
      },
    ];
    const r = simulateDispatch(baseInput);
    assert.equal(stage(r, "forward")[0].outcome, "miss");
  });

  it("renderSimulation 為純文字摘要", () => {
    config.skills = [{ id: "weather", enabled: true, trigger: "", allowedUsers: [], config: {} }];
    const text = renderSimulation(simulateDispatch(baseInput));
    assert.match(text, /\[模擬\] 阿寶請幫忙 天氣 台北/);
    assert.match(text, /✅ 技能｜天氣/);
  });

  it("技能定義遺失（外部技能被移除）如實呈現", () => {
    config.skills = [{ id: "gone", enabled: true, trigger: "", allowedUsers: [], config: {} }];
    const r = simulateDispatch(baseInput);
    const skills = stage(r, "skill");
    assert.equal(skills[0].outcome, "skipped");
    assert.match(skills[0].detail, /找不到技能定義/);
  });
});
