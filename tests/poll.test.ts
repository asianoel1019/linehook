import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pollSkill, { parsePollCommand } from "../src/skills/poll/index.js";
import type { SkillContext } from "../src/skills/types.js";

function harness(overrides: Partial<SkillContext> = {}) {
  const replies: string[] = [];
  const states: Record<string, Record<string, unknown>> = {};
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
    watch: (opts: { task: string; state?: Record<string, unknown> }) => {
      if (opts.state) states[opts.task] = opts.state;
      return `task:${opts.task}`;
    },
    unwatch: () => true,
    watches: () => [],
    taskState: (task: string) => states[task],
    ...overrides,
  } as unknown as SkillContext;
  const last = () => replies[replies.length - 1] ?? "";
  return { ctx, replies, states, last, polls: () => (states.polls?.polls ?? []) as Array<Record<string, unknown>> };
}

const CREATE = "要吃什麼? | 火鍋 | 日料 | 義大利麵";

describe("poll parsePollCommand", () => {
  it("查詢類指令", () => {
    assert.deepEqual(parsePollCommand(""), { op: "help" });
    assert.deepEqual(parsePollCommand("說明"), { op: "help" });
    assert.deepEqual(parsePollCommand("?"), { op: "help" });
    assert.deepEqual(parsePollCommand("結果"), { op: "result" });
    assert.deepEqual(parsePollCommand("status"), { op: "result" });
    assert.deepEqual(parsePollCommand("結束"), { op: "close" });
    assert.deepEqual(parsePollCommand("end"), { op: "close" });
    assert.deepEqual(parsePollCommand("清單"), { op: "list" });
    assert.deepEqual(parsePollCommand("list"), { op: "list" });
  });

  it("先去除語氣詞再解析", () => {
    assert.deepEqual(parsePollCommand("請幫忙結果"), { op: "result" });
    assert.deepEqual(parsePollCommand("麻煩清單"), { op: "list" });
    assert.deepEqual(parsePollCommand("幫我結束"), { op: "close" });
  });

  it("取消（可帶目標）", () => {
    assert.deepEqual(parsePollCommand("取消"), { op: "cancel", target: undefined });
    assert.deepEqual(parsePollCommand("取消 火鍋"), { op: "cancel", target: "火鍋" });
    assert.deepEqual(parsePollCommand("delete abc"), { op: "cancel", target: "abc" });
  });

  it("投票（數字或選項名）", () => {
    assert.deepEqual(parsePollCommand("1"), { op: "vote", target: "1" });
    assert.deepEqual(parsePollCommand("投 2"), { op: "vote", target: "2" });
    assert.deepEqual(parsePollCommand("vote 3"), { op: "vote", target: "3" });
    assert.deepEqual(parsePollCommand("火鍋"), { op: "vote", target: "火鍋" });
  });

  it("建立（問題 | 選項 | 選項），支援全形直線與前綴", () => {
    assert.deepEqual(parsePollCommand(CREATE), {
      op: "create",
      question: "要吃什麼?",
      options: ["火鍋", "日料", "義大利麵"],
    });
    assert.deepEqual(parsePollCommand("建立 吃飯｜A｜B｜C"), {
      op: "create",
      question: "吃飯",
      options: ["A", "B", "C"],
    });
    assert.deepEqual(parsePollCommand("create 選邊 | 左 | 右"), {
      op: "create",
      question: "選邊",
      options: ["左", "右"],
    });
  });

  it("選項不足兩項不視為建立", () => {
    assert.deepEqual(parsePollCommand("問題 | 只有一個"), { op: "help" });
  });
});

describe("poll run() 流程", () => {
  it("建立 → 投票 → 改投 → 結果 → 結束 → 清單 → 取消", async () => {
    const h = harness();

    await pollSkill.run({ ...h.ctx, args: CREATE });
    assert.match(h.last(), /投票已建立（ID: [a-z0-9]+）/);
    assert.match(h.last(), /1\. 火鍋/);
    assert.equal(h.polls().length, 1);

    await pollSkill.run({ ...h.ctx, args: "1" });
    assert.match(h.last(), /已投票：火鍋（目前 1 票）/);

    await pollSkill.run({ ...h.ctx, args: "火鍋" });
    assert.match(h.last(), /已改投：火鍋（目前 1 票）/);

    await pollSkill.run({ ...h.ctx, fromMid: "u2", args: "2" });
    assert.match(h.last(), /已投票：日料（目前 1 票）/);

    await pollSkill.run({ ...h.ctx, args: "結果" });
    assert.match(h.last(), /📊 要吃什麼\?/);
    assert.match(h.last(), /進行中 · 共 2 人投票/);
    assert.match(h.last(), /1\. 火鍋\s+\S+\s+1 票 \(50%\)/);

    await pollSkill.run({ ...h.ctx, args: "結束" });
    assert.match(h.last(), /投票已結束/);
    assert.equal(h.polls()[0].closed, true);

    await pollSkill.run({ ...h.ctx, args: "結果" });
    assert.match(h.last(), /目前沒有進行中的投票/);

    await pollSkill.run({ ...h.ctx, args: "清單" });
    assert.match(h.last(), /\[已結束\] 要吃什麼\?（2 票，3 選項）/);

    await pollSkill.run({ ...h.ctx, args: "取消" });
    assert.match(h.last(), /已取消投票：要吃什麼\?/);
    assert.equal(h.polls().length, 0);

    await pollSkill.run({ ...h.ctx, args: "清單" });
    assert.match(h.last(), /目前沒有任何投票/);
  });

  it("沒有進行中投票時投票／查結果", async () => {
    const h = harness();
    await pollSkill.run({ ...h.ctx, args: "1" });
    assert.match(h.last(), /目前沒有進行中的投票/);
    await pollSkill.run({ ...h.ctx, args: "結果" });
    assert.match(h.last(), /目前沒有進行中的投票/);
  });

  it("選項不存在時列出可選項", async () => {
    const h = harness();
    await pollSkill.run({ ...h.ctx, args: CREATE });
    await pollSkill.run({ ...h.ctx, args: "99" });
    assert.match(h.last(), /找不到選項「99」。可選：1\. 火鍋、2\. 日料、3\. 義大利麵/);
  });

  it("選項過多會被拒絕", async () => {
    const h = harness();
    const many = Array.from({ length: 11 }, (_, i) => `選項${i + 1}`);
    await pollSkill.run({ ...h.ctx, args: `問題 | ${many.join(" | ")}` });
    assert.match(h.last(), /選項最多 10 個/);
    assert.equal(h.polls().length, 0);
  });

  it("沒有參數時顯示用法", async () => {
    const h = harness();
    await pollSkill.run({ ...h.ctx, args: "" });
    assert.match(h.last(), /用法：/);
  });

  it("onTask 清除過期投票", async () => {
    const now = Date.now();
    const state = {
      polls: [
        { id: "old1", question: "舊的", options: [], votes: {}, createdBy: "u", createdByName: "n", createdAt: now - 30 * 86400000, closed: false },
        { id: "new1", question: "新的", options: [], votes: {}, createdBy: "u", createdByName: "n", createdAt: now - 86400000, closed: false },
      ],
    };
    let saved: Record<string, unknown> | undefined;
    await pollSkill.onTask!({
      taskId: "t1",
      task: "polls",
      chat: "c1",
      fromName: "n",
      config: { expireDays: "7" },
      args: {},
      state,
      saveState: async (patch) => {
        saved = patch;
      },
      reply: async () => {},
      sendImage: async () => {},
      sendFile: async () => {},
    });
    const kept = (saved?.polls ?? []) as Array<{ id: string }>;
    assert.deepEqual(kept.map((p) => p.id), ["new1"], "超過 7 天的投票應被清除");
  });
});
