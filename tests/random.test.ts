import { describe, it } from "node:test";
import assert from "node:assert/strict";
import randomSkill, { rollDice } from "../src/skills/random/index.js";
import type { SkillContext } from "../src/skills/types.js";

function harness(): { ctx: SkillContext; replies: string[]; last: () => string } {
  const replies: string[] = [];
  const ctx = {
    text: "",
    args: "",
    fromName: "tester",
    chat: "c1",
    fromMid: "u1",
    config: {},
    reply: async (t: string) => {
      replies.push(t);
    },
    sendImage: async () => {},
    sendFile: async () => {},
    schedule: () => "sched",
    watch: () => "task",
    unwatch: () => true,
    watches: () => [],
    taskState: () => undefined,
  } as unknown as SkillContext;
  return { ctx, replies, last: () => replies[replies.length - 1] ?? "" };
}

describe("random rollDice", () => {
  it("小面數=顆數（骰子 6 → 兩顆六面）", () => {
    const d = rollDice("6");
    assert.equal(d.faces, 6);
    assert.equal(d.count, 2);
    assert.equal(d.rolls.length, 2);
    assert.ok(d.rolls.every((r) => r >= 1 && r <= 6));
    assert.equal(d.total, d.rolls[0] + d.rolls[1]);
  });

  it("大面數=面數（骰子 20 → 一顆二十面）", () => {
    const d = rollDice("20");
    assert.equal(d.faces, 20);
    assert.equal(d.count, 1);
    assert.ok(d.rolls[0] >= 1 && d.rolls[0] <= 20);
  });

  it("空/壞輸入回退 6 面 2 顆", () => {
    assert.equal(rollDice("").faces, 6);
    assert.equal(rollDice("abc").faces, 6);
    assert.equal(rollDice("99999").faces, 6);
  });
});

describe("random run()", () => {
  it("骰子輸出在範圍內", async () => {
    const h = harness();
    await randomSkill.run({ ...h.ctx, args: "骰子 6" });
    assert.match(h.last(), /^🎲 2d6 = \d{1,2}（\d{1,2}、\d{1,2}）$/);
  });

  it("硬幣只會正面/反面", async () => {
    const h = harness();
    await randomSkill.run({ ...h.ctx, args: "硬幣" });
    assert.match(h.last(), /^🪙 (正面|反面)$/);
  });

  it("吃什麼：內建清單或自訂清單", async () => {
    const h = harness();
    await randomSkill.run({ ...h.ctx, args: "吃什麼" });
    assert.match(h.last(), /今天就吃「.+/);
    await randomSkill.run({ ...h.ctx, args: "吃什麼 泡麵 便當 咖哩" });
    assert.ok(["泡麵", "便當", "咖哩"].some((f) => h.last().includes(f)));
  });

  it("抽籤從清單選一個", async () => {
    const h = harness();
    await randomSkill.run({ ...h.ctx, args: "抽籤 拉麵 壽司 咖哩" });
    assert.match(h.last(), /^🎯 選「(拉麵|壽司|咖哩)」！$/);
  });

  it("運勢給運勢文案", async () => {
    const h = harness();
    await randomSkill.run({ ...h.ctx, args: "運勢" });
    assert.match(h.last(), /今日運勢：(大吉|中吉|小吉|吉|末吉|凶|大凶)/);
    assert.match(h.last(), /幸運數字 \d/);
  });

  it("沒有參數給用法", async () => {
    const h = harness();
    await randomSkill.run({ ...h.ctx, args: "" });
    assert.match(h.last(), /骰子（或 骰子 20/);
  });
});
