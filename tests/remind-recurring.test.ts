import { describe, it } from "node:test";
import assert from "node:assert/strict";
import remindSkill, { parseRecurring } from "../src/skills/remind/index.js";
import type { SkillContext, SkillWatchView } from "../src/skills/types.js";

interface WatchOpts {
  task: string;
  cron?: string;
  everyMinutes?: number;
  at?: string;
  args?: Record<string, string | number | boolean>;
}

interface Harness {
  ctx: SkillContext;
  replies: string[];
  last: () => string;
  watches: WatchOpts[];
}

function harness(): Harness {
  const replies: string[] = [];
  const watches: WatchOpts[] = [];
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
    schedule: () => "sched-1",
    watch: (opts: WatchOpts) => {
      const existing = watches.findIndex((w) => w.task === opts.task);
      if (existing >= 0) watches[existing] = opts;
      else watches.push(opts);
      return `task:${opts.task}`;
    },
    unwatch: (taskOrId: string) => {
      const idx = watches.findIndex((w) => w.task === taskOrId || `task:${w.task}` === taskOrId);
      if (idx >= 0) watches.splice(idx, 1);
      return idx >= 0;
    },
    watches: () =>
      watches.map<SkillWatchView>((w) => ({
        id: `task:${w.task}`,
        task: w.task,
        cron: w.cron ?? "",
        runAt: "2026-10-10T08:00:00",
        args: w.args ?? {},
      })),
    taskState: () => undefined,
  } as unknown as SkillContext;
  return { ctx, replies, last: () => replies[replies.length - 1] ?? "", watches };
}

describe("remind parseRecurring", () => {
  it("每天 / 平日 / 週末", () => {
    const daily = parseRecurring("每天 08:00 吃藥");
    assert.ok(daily);
    assert.equal(daily?.label, "每天 08:00");
    assert.equal(daily?.content, "吃藥");
    assert.deepEqual(daily?.watch, { cron: "0 8 * * *" });

    const weekday = parseRecurring("平日 22:30 睡覺");
    assert.deepEqual(weekday?.watch, { cron: "30 22 * * 1-5" });

    const weekend = parseRecurring("週末 10:00 爬山");
    assert.deepEqual(weekend?.watch, { cron: "0 10 * * 6,0" });
  });

  it("每週一支援「每週X」「星期X」", () => {
    const a = parseRecurring("每週一 09:00 開會");
    assert.deepEqual(a?.watch, { cron: "0 9 * * 1" });
    assert.equal(a?.content, "開會");
    const b = parseRecurring("星期三 19:00 打球");
    assert.deepEqual(b?.watch, { cron: "0 19 * * 3" });
    assert.equal(b?.content, "打球");
  });

  it("每月 N 號", () => {
    const m = parseRecurring("每月 5 號 10:00 繳房租");
    assert.deepEqual(m?.watch, { cron: "0 10 5 * *" });
    assert.equal(m?.label, "每月 5 號 10:00");
  });

  it("每隔 N 分鐘/小時", () => {
    assert.deepEqual(parseRecurring("每隔 45 分鐘 喝水")?.watch, { everyMinutes: 45 });
    assert.equal(parseRecurring("每隔 3 小時 喝水")?.label, "每 3 小時");
    assert.deepEqual(parseRecurring("每隔 3 小時 喝水")?.watch, { everyMinutes: 180 });
    // 90 分鐘不是 60 的倍數 → 不支援（回 null，由呼叫端給語法提示）
    assert.equal(parseRecurring("每隔 90 分鐘 喝水"), null);
  });

  it("農曆生日", () => {
    const lunar = parseRecurring("農曆 7/15 09:00 中元節");
    assert.ok(lunar);
    assert.equal(lunar?.label, "農曆 7/15 09:00");
    assert.equal(lunar?.content, "中元節");
    assert.deepEqual(lunar?.watch, { lunar: { month: 7, day: 15 }, at: "09:00" });
  });

  it("內容不會誤吃中文數字（三國志）", () => {
    const r = parseRecurring("每天 21:00 看三國志");
    assert.equal(r?.content, "看三國志");
  });

  it("單次提醒語法不視為週期性", () => {
    assert.equal(parseRecurring("30分鐘後 喝水"), null);
    assert.equal(parseRecurring("明天 09:00 開會"), null);
    assert.equal(parseRecurring("9:30 開會"), null);
  });
});

describe("remind run() 週期性", () => {
  it("每天提醒註冊 cron 任務", async () => {
    const h = harness();
    await remindSkill.run({ ...h.ctx, args: "每天 08:00 吃藥" });
    assert.match(h.last(), /每天 08:00 提醒你/);
    assert.equal(h.watches.length, 1);
    assert.equal(h.watches[0].cron, "0 8 * * *");
    assert.equal(h.watches[0].args?.text, "吃藥");
  });

  it("同內容同時間重複註冊會取代（不疊加）", async () => {
    const h = harness();
    await remindSkill.run({ ...h.ctx, args: "每天 08:00 吃藥" });
    await remindSkill.run({ ...h.ctx, args: "每天 08:00 吃藥" });
    assert.equal(h.watches.length, 1);
  });

  it("同內容不同時間可並存", async () => {
    const h = harness();
    await remindSkill.run({ ...h.ctx, args: "每天 08:00 吃藥" });
    await remindSkill.run({ ...h.ctx, args: "每天 20:00 吃藥" });
    assert.equal(h.watches.length, 2);
  });

  it("每隔 90 分鐘給語法提示而非亂排程", async () => {
    const h = harness();
    await remindSkill.run({ ...h.ctx, args: "每隔 90 分鐘 喝水" });
    assert.match(h.last(), /僅支援 1–60 或 60 的倍數/);
    assert.equal(h.watches.length, 0);
  });

  it("清單與取消（關鍵字／全部）", async () => {
    const h = harness();
    await remindSkill.run({ ...h.ctx, args: "清單" });
    assert.match(h.last(), /目前沒有週期性提醒/);

    await remindSkill.run({ ...h.ctx, args: "每天 08:00 吃藥" });
    await remindSkill.run({ ...h.ctx, args: "每週一 09:00 開會" });
    await remindSkill.run({ ...h.ctx, args: "清單" });
    assert.match(h.last(), /週期性提醒（2）/);
    assert.match(h.last(), /吃藥｜每天 08:00/);
    assert.match(h.last(), /開會｜每週一 09:00/);

    await remindSkill.run({ ...h.ctx, args: "取消 吃藥" });
    assert.match(h.last(), /已取消 1 個提醒：吃藥/);
    assert.equal(h.watches.length, 1);

    await remindSkill.run({ ...h.ctx, args: "取消" });
    assert.match(h.last(), /已取消全部 1 個/);
    assert.equal(h.watches.length, 0);
  });

  it("取消找不到的關鍵字給提示", async () => {
    const h = harness();
    await remindSkill.run({ ...h.ctx, args: "每天 08:00 吃藥" });
    await remindSkill.run({ ...h.ctx, args: "取消 睡覺" });
    assert.match(h.last(), /找不到含「睡覺」/);
    assert.equal(h.watches.length, 1);
  });

  it("單次提醒仍可用 schedule", async () => {
    const h = harness();
    await remindSkill.run({ ...h.ctx, args: "30分鐘後 喝水" });
    assert.match(h.last(), /將於 .+ 提醒你：「喝水」/);
    assert.equal(h.watches.length, 0);
  });

  it("沒有參數時給完整用法", async () => {
    const h = harness();
    await remindSkill.run({ ...h.ctx, args: "" });
    assert.match(h.last(), /每天 08:00 吃藥/);
    assert.match(h.last(), /農曆 7\/15 09:00 中元節/);
  });
});

describe("remind onTask", () => {
  const baseCtx = {
    taskId: "t",
    task: "r-xxx",
    chat: "c1",
    fromName: "tester",
    config: {},
    state: {} as Record<string, unknown>,
    saveState: async () => {},
    sendImage: async () => {},
    sendFile: async () => {},
  };

  it("一般任務推播內容", async () => {
    const replies: string[] = [];
    await remindSkill.onTask!({
      ...baseCtx,
      args: { text: "吃藥" },
      state: {},
      reply: async (t: string) => {
        replies.push(t);
      },
    } as never);
    assert.deepEqual(replies, ["⏰ 吃藥"]);
  });

  it("農曆任務只在地下生日日期匹配時推播", async () => {
    const replies: string[] = [];
    const now = new Date();
    // 今天的農曆月日
    const { solarToLunar } = await import("../src/skills/lunar/index.js");
    const today = solarToLunar(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const wrong = today.month === 3 ? { month: 4, day: 15 } : { month: 3, day: 15 };
    await remindSkill.onTask!({
      ...baseCtx,
      args: { text: "中元節", lunarMonth: wrong.month, lunarDay: wrong.day },
      state: {},
      reply: async (t: string) => {
        replies.push(t);
      },
    } as never);
    assert.deepEqual(replies, [], "農曆不對不應推播");
  });
});
