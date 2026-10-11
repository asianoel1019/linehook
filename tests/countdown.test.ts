import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nowInTz } from "../src/time.js";
import { parseItem, renderLine, upcomingOf } from "../src/skills/countdown/index.js";
import countdownSkill from "../src/skills/countdown/index.js";
import type { SkillContext } from "../src/skills/types.js";

const NOW = new Date(2026, 9, 10); // 2026-10-10 當地時間

describe("countdown parseItem", () => {
  it("完整日期 → 單次倒數", () => {
    const it1 = parseItem("2026-12-31 跨年", NOW);
    assert.ok(it1);
    assert.equal(it1?.date, "2026-12-31");
    assert.equal(it1?.yearly, false);
    assert.equal(it1?.label, "跨年");
  });

  it("過去日期自動轉週年", () => {
    const it1 = parseItem("2020-05-20 交往紀念日", NOW);
    assert.equal(it1?.yearly, true);
    assert.equal(it1?.date, "05-20");
    assert.equal(it1?.label, "交往紀念日");
  });

  it("「每年」關鍵字 → 週年", () => {
    const it1 = parseItem("每年 5/20 交往", NOW);
    assert.equal(it1?.yearly, true);
    assert.equal(it1?.date, "05-20");
    assert.equal(it1?.label, "交往");
  });

  it("提前 N 天", () => {
    const it1 = parseItem("6/6 端午 提前3天", NOW);
    assert.equal(it1?.aheadDays, 3);
    assert.equal(it1?.date, "06-06");
  });

  it("壞輸入回 null", () => {
    assert.equal(parseItem("", NOW), null);
    assert.equal(parseItem("沒有日期", NOW), null);
    assert.equal(parseItem("13/45 怪日期", NOW), null);
    assert.equal(parseItem("12/31 沒有標籤", NOW)?.label, "沒有標籤");
  });
});

describe("countdown upcomingOf / renderLine", () => {
  const yearly = parseItem("每年 5/20 交往", NOW)!;
  yearly.createdAt = new Date(2020, 4, 20).getTime();

  it("週年紀念算下一個發生日與週數", () => {
    const u = upcomingOf(yearly, "2026-10-10");
    assert.equal(u.nextDate, "2027-05-20");
    assert.equal(u.days, 222);
    assert.equal(u.anniversary, 7);
  });

  it("單次倒數（日期過後為負）", () => {
    const once = parseItem("2026-10-05 已過", NOW)!;
    const u = upcomingOf(once, "2026-10-10");
    assert.equal(u.days, -5);
    assert.equal(u.anniversary, undefined);
  });

  it("當天顯示「就是今天」與週年", () => {
    const item = { ...yearly, createdAt: new Date(2020, 4, 20).getTime() };
    item.date = "10-10";
    const line = renderLine(1, item, "2026-10-10");
    assert.match(line, /🎉/);
    assert.match(line, /第 6 週年/);
    assert.match(line, /就是今天/);
  });

  it("清單行含倒數天數", () => {
    const line = renderLine(1, yearly, "2026-10-10");
    assert.match(line, /^1\. 交往｜每年 5\/20｜還有 222 天$/);
  });
});

describe("countdown run()", () => {
  function harness(): { ctx: SkillContext; replies: string[]; state: () => Record<string, unknown> } {
    const replies: string[] = [];
    let state: Record<string, unknown> = { items: [], seq: 0 };
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
        if (opts.state) state = opts.state;
        return "task:daily";
      },
      unwatch: () => true,
      watches: () => [],
      taskState: (t: string) => (t === "daily" ? state : undefined),
    } as unknown as SkillContext;
    return { ctx, replies, state: () => state, last: () => replies[replies.length - 1] ?? "" } as never;
  }

  it("新增（每年）→ 清單 → 刪除", async () => {
    const h = harness();

    await countdownSkill.run({ ...h.ctx, args: "每年 5/20 交往" });
    assert.match(h.last(), /已紀錄：交往｜每年 05\/20（每年週年提醒）/);

    await countdownSkill.run({ ...h.ctx, args: "2026-12-31 跨年" });
    assert.match(h.last(), /還有 \d+ 天/);

    await countdownSkill.run({ ...h.ctx, args: "清單" });
    assert.match(h.last(), /紀念日／倒數（2）/);
    assert.match(h.last(), /跨年｜2026\/12\/31/);

    // 依遠近排序：跨年較近排第 1
    await countdownSkill.run({ ...h.ctx, args: "刪除 1" });
    assert.match(h.last(), /已刪除：跨年/);
    assert.equal((h.state().items as unknown[]).length, 1);
  });

  it("空清單與壞日期給提示", async () => {
    const h = harness();
    await countdownSkill.run({ ...h.ctx, args: "" });
    assert.match(h.last(), /目前沒有紀念日/);
    await countdownSkill.run({ ...h.ctx, args: "abc" });
    assert.match(h.last(), /用法：/);
  });
});

describe("countdown onTask", () => {
  const baseCtx = {
    taskId: "t",
    task: "daily",
    chat: "c1",
    fromName: "t",
    config: {},
    args: {},
    saveState: async () => {},
    sendImage: async () => {},
    sendFile: async () => {},
  };

  it("只對今天（與提前天數）的項目推播", async () => {
    const now = nowInTz();
    const p = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    const soon = new Date(now.getTime() + 3 * 86_400_000);
    const far = new Date(now.getTime() + 9 * 86_400_000);
    const fmt = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const replies: string[] = [];
    await countdownSkill.onTask!({
      ...baseCtx,
      state: {
        items: [
          { id: 1, date: today, label: "今天這事", yearly: false, aheadDays: 0, by: "", createdAt: Date.now() },
          { id: 2, date: fmt(soon), label: "三天後", yearly: false, aheadDays: 3, by: "", createdAt: Date.now() },
          { id: 3, date: fmt(far), label: "九天後", yearly: false, aheadDays: 0, by: "", createdAt: Date.now() },
        ],
        seq: 3,
      },
      reply: async (t: string) => {
        replies.push(t);
      },
    });
    assert.equal(replies.length, 2);
    assert.ok(replies.some((r) => r.includes("今天這事") && r.includes("今天")));
    assert.ok(replies.some((r) => r.includes("倒數 3 天") && r.includes("三天後")));
  });
});
