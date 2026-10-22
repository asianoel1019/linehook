import { describe, it } from "node:test";
import assert from "node:assert/strict";
import autoReplySkill, {
  activeRules,
  cooldownSecOf,
  parseHm,
  parseWeekdays,
  resolveAutoReply,
  ruleScheduleOk,
  splitVariants,
  pickVariant,
  parseProbability,
  rollProbability,
} from "../src/skills/auto-reply/index.js";
import type { SkillContext } from "../src/skills/types.js";

/* ── 純函式 ── */

describe("parseHm / parseWeekdays", () => {
  it("HH:mm 解析與壞值", () => {
    assert.equal(parseHm("09:30"), 9 * 60 + 30);
    assert.equal(parseHm("23:59"), 23 * 60 + 59);
    assert.equal(parseHm("9：05"), 9 * 60 + 5, "全形冒號也可");
    assert.equal(parseHm(""), null);
    assert.equal(parseHm("24:00"), null);
    assert.equal(parseHm("abc"), null);
    assert.equal(parseHm(undefined), null);
  });

  it("星期：1=週一…7=週日；0 或 7 都算週日", () => {
    assert.deepEqual([...parseWeekdays("1,2,3,4,5")!], [1, 2, 3, 4, 5]);
    assert.deepEqual([...parseWeekdays("7")!], [7]);
    assert.deepEqual([...parseWeekdays("0")!], [7]);
    assert.equal(parseWeekdays(""), null);
    assert.equal(parseWeekdays("a,b"), null);
    assert.equal(parseWeekdays("8"), null);
  });
});

describe("ruleScheduleOk", () => {
  const at = (h: number, m: number, day: number): Date => new Date(2026, 9, 12 + day, h, m); // 2026-10-12 是週一

  it("沒有限定 → 全放行", () => {
    assert.equal(ruleScheduleOk({ keyword: "x" }, at(3, 0, 0)), true);
  });

  it("一般時段（早上九點到晚上六點）", () => {
    const rule = { keyword: "x", timeFrom: "09:00", timeTo: "18:00" };
    assert.equal(ruleScheduleOk(rule, at(9, 0, 0)), true, "起始點含");
    assert.equal(ruleScheduleOk(rule, at(17, 59, 0)), true);
    assert.equal(ruleScheduleOk(rule, at(18, 0, 0)), false, "結束點不含");
    assert.equal(ruleScheduleOk(rule, at(23, 0, 0)), false);
  });

  it("跨夜時段（22:00–06:00）", () => {
    const rule = { keyword: "x", timeFrom: "22:00", timeTo: "06:00" };
    assert.equal(ruleScheduleOk(rule, at(23, 30, 0)), true);
    assert.equal(ruleScheduleOk(rule, at(2, 0, 0)), true);
    assert.equal(ruleScheduleOk(rule, at(6, 0, 0)), false);
    assert.equal(ruleScheduleOk(rule, at(12, 0, 0)), false);
  });

  it("星期過濾（週一~週五）", () => {
    const rule = { keyword: "x", weekdays: "1,2,3,4,5" };
    assert.equal(ruleScheduleOk(rule, at(10, 0, 0)), true, "週一");
    assert.equal(ruleScheduleOk(rule, at(10, 0, 5)), false, "週六");
    assert.equal(ruleScheduleOk(rule, at(10, 0, 6)), false, "週日");
    assert.equal(ruleScheduleOk({ keyword: "x", weekdays: "6,7" }, at(10, 0, 5)), true);
  });

  it("起訖相同視為全天", () => {
    assert.equal(ruleScheduleOk({ keyword: "x", timeFrom: "12:00", timeTo: "12:00" }, at(0, 0, 0)), true);
  });
});

describe("resolveAutoReply（run 與模擬器共用）", () => {
  const cfg = (rules: unknown[], cooldownSec = "10"): Record<string, string> => ({
    cooldownSec,
    rules: JSON.stringify(rules),
  });
  const mon = new Date(2026, 9, 12, 10, 0); // 週一 10:00

  it("沒有規則命中 → miss", () => {
    const d = resolveAutoReply(cfg([{ keyword: "報價" }]), "你好", "c1", "u1", mon);
    assert.equal(d.outcome, "miss");
  });

  it("關鍵字命中但不在時段 → blocked 並說明", () => {
    const d = resolveAutoReply(
      cfg([{ keyword: "報價", match: "contains", timeFrom: "09:00", timeTo: "18:00" }]),
      "請問報價",
      "c1",
      "u1",
      new Date(2026, 9, 12, 21, 0),
    );
    assert.equal(d.outcome, "blocked");
    assert.match(d.outcome === "blocked" ? d.reason : "", /不在時段 09:00–18:00/);
  });

  it("星期不符 → blocked 並說明", () => {
    const d = resolveAutoReply(
      cfg([{ keyword: "報價", weekdays: "1,2,3,4,5" }]),
      "報價",
      "c1",
      "u1",
      new Date(2026, 9, 17, 10, 0),
    );
    assert.equal(d.outcome, "blocked");
    assert.match(d.outcome === "blocked" ? d.reason : "", /今天不是設定的星期/);
  });

  it("命中且放行 → hit", () => {
    const d = resolveAutoReply(cfg([{ keyword: "報價", match: "contains" }]), "請問報價", "c1", "u1", mon);
    assert.equal(d.outcome, "hit");
  });

  it("每來源冷卻：同一對話不同寄件者互不影響", () => {
    const rules = [{ keyword: "報價", cooldownSec: 60 }];
    assert.equal(resolveAutoReply(cfg(rules), "報價", "c1", "u1", mon).outcome, "hit");
    // u1 真的回一次 → 寫入冷卻（用 run 走一遍）
    return autoReplySkill.run(ctxFor("報價", "c1", "u1")).then(() => {
      assert.equal(resolveAutoReply(cfg(rules), "報價", "c1", "u1", mon).outcome, "blocked", "同一個人被冷卻");
      assert.equal(resolveAutoReply(cfg(rules), "報價", "c1", "u2", mon).outcome, "hit", "換個人立刻放行");
      assert.equal(resolveAutoReply(cfg(rules), "報價", "c2", "u1", mon).outcome, "hit", "換對話也放行");
    });
  });

  it("cooldownSecOf：規則覆寫 > 全域 > 0", () => {
    assert.equal(cooldownSecOf({ keyword: "x", cooldownSec: 30 }, "10"), 30);
    assert.equal(cooldownSecOf({ keyword: "x" }, "10"), 10);
    assert.equal(cooldownSecOf({ keyword: "x" }, "壞的"), 0);
    assert.equal(cooldownSecOf({ keyword: "x", cooldownSec: 0 }, "10"), 0, "0 = 這條不冷卻");
  });

  it("activeRules 仍保留全部啟用規則（含不在時段的）", () => {
    const rules = [
      { keyword: "a" },
      { keyword: "b", timeFrom: "23:00", timeTo: "01:00" },
      { keyword: "c", enabled: false },
      { keyword: "" },
    ];
    assert.equal(activeRules({ rules: JSON.stringify(rules) }).length, 2);
  });
});

function ctxFor(text: string, chat: string, fromMid: string): SkillContext {
  return {
    text,
    args: text,
    fromName: "小明",
    chat,
    fromMid,
    config: {
      cooldownSec: "60",
      rules: JSON.stringify([{ keyword: "報價", match: "contains", text: "已收到", cooldownSec: 60 }]),
    },
    reply: async () => {},
    sendImage: async () => {},
    sendFile: async () => {},
    schedule: () => "",
    watch: () => "",
    unwatch: () => true,
    watches: () => [],
    taskState: () => undefined,
  } as unknown as SkillContext;
}

describe("auto-reply run()", () => {
  it("星期不符就不回應（確定性）", async () => {
    // 規則只在「週日」生效；今天若不是週日就一定不會回
    const today = new Date().getDay();
    const rules = [{ keyword: "報價", match: "contains", text: "回覆", weekdays: today === 0 ? "1" : "0" }];
    const replies: string[] = [];
    await autoReplySkill.run({
      ...ctxFor("報價", "weekday-chat", "u9"),
      config: { cooldownSec: "0", rules: JSON.stringify(rules) },
      reply: async (t: string) => {
        replies.push(t);
      },
    } as unknown as SkillContext);
    assert.deepEqual(replies, []);
  });

  it("命中就回應並套用範本變數", async () => {
    const replies: string[] = [];
    await autoReplySkill.run({
      ...ctxFor("報價", "tmpl-chat", "u1"),
      reply: async (t: string) => {
        replies.push(t);
      },
    } as unknown as SkillContext);
    assert.deepEqual(replies, ["已收到"]);
  });
});

describe("auto-reply 多則輪替與機率", () => {
  it("splitVariants：|| 分隔、去空；無分隔回原文", () => {
    assert.deepEqual(splitVariants("早安||早安安||早☀️"), ["早安", "早安安", "早☀️"]);
    assert.deepEqual(splitVariants("只有一則"), ["只有一則"]);
    assert.deepEqual(splitVariants(""), []);
    assert.deepEqual(splitVariants(undefined), []);
    assert.deepEqual(splitVariants("a||||b"), ["a", "b"]);
  });

  it("pickVariant：邊界索引", () => {
    assert.equal(pickVariant(["a", "b", "c"], 0), "a");
    assert.equal(pickVariant(["a", "b", "c"], 0.5), "b");
    assert.equal(pickVariant(["a", "b", "c"], 0.9999), "c");
    assert.equal(pickVariant([], 0.5), "");
  });

  it("parseProbability：夾取 0–1、非法回 1", () => {
    assert.equal(parseProbability(0.3), 0.3);
    assert.equal(parseProbability("0.5"), 0.5);
    assert.equal(parseProbability(2), 1);
    assert.equal(parseProbability(-1), 0);
    assert.equal(parseProbability(undefined), 1);
    assert.equal(parseProbability("壞的"), 1);
  });

  it("rollProbability：p=1 必中、p=0 必不中", () => {
    assert.equal(rollProbability(1, 0.99), true);
    assert.equal(rollProbability(0, 0), false);
    assert.equal(rollProbability(0.5, 0.4), true);
    assert.equal(rollProbability(0.5, 0.6), false);
  });

  it("run()：多則回覆落在集合內且套用變數", async () => {
    const replies: string[] = [];
    await autoReplySkill.run({
      ...ctxFor("報價", "variant-chat", "u1"),
      config: {
        cooldownSec: "0",
        rules: JSON.stringify([{ keyword: "報價", match: "contains", text: "Hi {{name}}||Yo {{name}}" }]),
      },
      reply: async (t: string) => {
        replies.push(t);
      },
    } as unknown as SkillContext);
    assert.equal(replies.length, 1);
    assert.ok(replies[0] === "Hi 小明" || replies[0] === "Yo 小明", replies[0]);
  });

  it("run()：機率 0 不回且不吃冷卻", async () => {
    const rules = [{ keyword: "報價", match: "contains", text: "已收到", probability: 0 }];
    const r1: string[] = [];
    await autoReplySkill.run({
      ...ctxFor("報價", "prob-chat", "u1"),
      config: { cooldownSec: "60", rules: JSON.stringify(rules) },
      reply: async (t: string) => {
        r1.push(t);
      },
    } as unknown as SkillContext);
    assert.deepEqual(r1, []);
    // 冷卻沒被吃掉：同規則機率改 1 立刻能回
    const r2: string[] = [];
    await autoReplySkill.run({
      ...ctxFor("報價", "prob-chat", "u1"),
      config: { cooldownSec: "60", rules: JSON.stringify([{ ...rules[0], probability: 1 }]) },
      reply: async (t: string) => {
        r2.push(t);
      },
    } as unknown as SkillContext);
    assert.deepEqual(r2, ["已收到"]);
  });
});
