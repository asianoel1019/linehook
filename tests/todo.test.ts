import { describe, it } from "node:test";
import assert from "node:assert/strict";
import todoSkill, { parseIndices, sortItems } from "../src/skills/todo/index.js";
import type { SkillContext } from "../src/skills/types.js";

interface Harness {
  ctx: SkillContext;
  replies: string[];
  last: () => string;
  items: () => Array<Record<string, unknown>>;
}

function harness(config: Record<string, string> = {}): Harness {
  const replies: string[] = [];
  let state: Record<string, unknown> = { items: [], seq: 0 };
  const ctx = {
    text: "",
    args: "",
    fromName: "tester",
    chat: "c1",
    fromMid: "u1",
    config,
    reply: async (t: string) => {
      replies.push(t);
    },
    sendImage: async () => {},
    sendFile: async () => {},
    schedule: () => "sched",
    watch: (opts: { task: string; state?: Record<string, unknown> }) => {
      if (opts.state) state = opts.state;
      return `task:${opts.task}`;
    },
    unwatch: () => true,
    watches: () => [],
    taskState: (task: string) => (task === "list" ? state : undefined),
  } as unknown as SkillContext;
  return {
    ctx,
    replies,
    last: () => replies[replies.length - 1] ?? "",
    items: () => (state.items ?? []) as Array<Record<string, unknown>>,
  };
}

describe("todo helpers", () => {
  it("未完成優先、新的在前", () => {
    const items = [
      { id: 1, text: "舊未完成", done: false, createdAt: 1 },
      { id: 2, text: "新未完成", done: false, createdAt: 2 },
      { id: 3, text: "已完成", done: true, createdAt: 3 },
    ];
    assert.deepEqual(
      sortItems(items).map((i) => i.id),
      [2, 1, 3],
    );
  });

  it("parseIndices 支援 1、1,2、全部；越界回 null", () => {
    assert.deepEqual(parseIndices("1", 3), [1]);
    assert.deepEqual(parseIndices("1,3", 3), [1, 3]);
    assert.deepEqual(parseIndices("全部", 2), [1, 2]);
    assert.equal(parseIndices("4", 3), null);
    assert.equal(parseIndices("", 3), null);
  });
});

describe("todo run() 流程", () => {
  it("新增多項（頓號分隔）→ 清單 → 完成 → 清除已完成", async () => {
    const h = harness();

    await todoSkill.run({ ...h.ctx, args: "買牛奶、雞蛋" });
    assert.match(h.last(), /已加入 2 項/);
    assert.equal(h.items().length, 2);
    assert.equal(h.items()[0].done, false);

    await todoSkill.run({ ...h.ctx, args: "清單" });
    assert.match(h.last(), /未完成 2・已完成 0/);
    assert.match(h.last(), /▫ 買牛奶/);
    assert.match(h.last(), /▫ 雞蛋/);

    // 同一毫秒新增 → 穩定排序維持加入順序（買牛奶第 1、雞蛋第 2）
    await todoSkill.run({ ...h.ctx, args: "完成 1" });
    assert.match(h.last(), /已完成 1 項，剩未完成 1 項/);
    const milk = h.items().find((i) => i.text === "買牛奶");
    const egg = h.items().find((i) => i.text === "雞蛋");
    assert.equal(milk?.done, true);
    assert.equal(egg?.done, false);

    await todoSkill.run({ ...h.ctx, args: "清除已完成" });
    assert.match(h.last(), /已清除 1 個已完成項目/);
    assert.equal(h.items().length, 1);
    assert.equal(h.items()[0].text, "雞蛋");
  });

  it("純編號切換完成狀態", async () => {
    const h = harness();
    await todoSkill.run({ ...h.ctx, args: "繳稅" });
    await todoSkill.run({ ...h.ctx, args: "1" });
    assert.match(h.last(), /完成 1 項/);
    assert.equal(h.items()[0].done, true);
    await todoSkill.run({ ...h.ctx, args: "1" });
    assert.match(h.last(), /取消完成 1 項/);
    assert.equal(h.items()[0].done, false);
  });

  it("重複項目不會重複加入", async () => {
    const h = harness();
    await todoSkill.run({ ...h.ctx, args: "繳稅" });
    await todoSkill.run({ ...h.ctx, args: "繳稅" });
    assert.match(h.last(), /都已經在清單裡/);
    assert.equal(h.items().length, 1);
  });

  it("達到上限時擋下", async () => {
    const h = harness({ maxItems: "2" });
    await todoSkill.run({ ...h.ctx, args: "A" });
    await todoSkill.run({ ...h.ctx, args: "B" });
    await todoSkill.run({ ...h.ctx, args: "C" });
    assert.match(h.last(), /待辦已達上限（2 項）/);
    assert.equal(h.items().length, 2);
  });

  it("刪除支援多編號，越界給提示", async () => {
    const h = harness();
    await todoSkill.run({ ...h.ctx, args: "A,B,C" });
    await todoSkill.run({ ...h.ctx, args: "刪除 1,3" });
    assert.match(h.last(), /已刪除：C、A/);
    assert.equal(h.items().length, 1);
    await todoSkill.run({ ...h.ctx, args: "刪除 9" });
    assert.match(h.last(), /用法：待辦 刪除 1/);
  });

  it("空清單時各指令的提示", async () => {
    const h = harness();
    await todoSkill.run({ ...h.ctx, args: "" });
    assert.match(h.last(), /目前沒有待辦事項/);
    await todoSkill.run({ ...h.ctx, args: "完成 1" });
    assert.match(h.last(), /用法：待辦 完成 1/);
    await todoSkill.run({ ...h.ctx, args: "清除已完成" });
    assert.match(h.last(), /目前沒有已完成的項目/);
  });
});

describe("todo onTask 清掉過期的已完成項目", () => {
  it("只刪超過 7 天的已完成項", async () => {
    const now = Date.now();
    const state = {
      items: [
        { id: 1, text: "新完成", done: true, doneAt: now, createdAt: now - 1000 },
        { id: 2, text: "舊完成", done: true, doneAt: now - 9 * 86_400_000, createdAt: now - 10 * 86_400_000 },
        { id: 3, text: "未完成", done: false, createdAt: now - 5 * 86_400_000 },
      ],
      seq: 3,
    };
    let saved: Record<string, unknown> | undefined;
    await todoSkill.onTask!({
      taskId: "t",
      task: "list",
      chat: "c",
      fromName: "n",
      config: {},
      args: {},
      state,
      saveState: async (patch) => {
        saved = patch;
      },
      reply: async () => {},
      sendImage: async () => {},
      sendFile: async () => {},
    });
    const kept = (saved?.items ?? []) as Array<{ text: string }>;
    assert.equal(kept.length, 2);
    assert.ok(kept.some((i) => i.text === "新完成"));
    assert.ok(kept.some((i) => i.text === "未完成"));
    assert.ok(!kept.some((i) => i.text === "舊完成"));
    assert.equal(saved?.seq, 3);
  });

  it("沒有需清除的項目不存檔", async () => {
    let called = false;
    await todoSkill.onTask!({
      taskId: "t",
      task: "list",
      chat: "c",
      fromName: "n",
      config: {},
      args: {},
      state: { items: [{ id: 1, text: "未完成", done: false, createdAt: Date.now() }] },
      saveState: async () => {
        called = true;
      },
      reply: async () => {},
      sendImage: async () => {},
      sendFile: async () => {},
    });
    assert.equal(called, false);
  });
});

describe("todo 到期日", () => {
  it("新增「買牛奶 明天」自動解析期限並顯示", async () => {
    const h = harness();
    await todoSkill.run({ ...h.ctx, args: "買牛奶 明天" });
    assert.match(h.last(), /已加入 1 項：買牛奶/);
    const due = h.items()[0].due as string;
    assert.match(due, /^\d{4}-\d{2}-\d{2}$/);
    await todoSkill.run({ ...h.ctx, args: "清單" });
    assert.match(h.last(), /買牛奶（\d{2}\/\d{2}到期）/);
  });
});
