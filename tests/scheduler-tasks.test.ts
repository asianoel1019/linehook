import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SCHEDULES_PATH = join(tmpdir(), `sched-tasks-test-${process.pid}.json`);

// 必須在設定 env 後才動態載入（config 在 import 時讀 env）
const { SendScheduler } = await import("../src/line/scheduler.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("scheduler skill tasks", () => {
  it("註冊、觸發、推進、存 state、取消", async () => {
    const fired: string[] = [];
    const sched = new SendScheduler(
      async () => {
        throw new Error("不該執行一般訊息");
      },
      async (job) => {
        fired.push(job.id);
      },
    );
    const view = sched.add([], Date.now() - 1000, "* * * * *", {
      skillId: "price-alert",
      task: "check",
      chat: "c1",
      args: { a: 1 },
      state: {},
    });
    assert.ok(view.skillTask);
    assert.equal(view.skillTask?.skillId, "price-alert");
    assert.equal(view.summary, "技能任務：price-alert/check");

    await sleep(1500);
    assert.equal(fired.length, 1);

    const after = sched.list().find((j) => j.id === view.id);
    assert.ok(after && new Date(after.runAt).getTime() > Date.now());

    assert.equal(sched.saveSkillState(view.id, { n: 1 }), true);
    assert.equal(sched.saveSkillState("不存在的id", {}), false);

    assert.equal(sched.cancel(view.id), true);
    assert.equal(sched.list().length, 0);
    sched.stop();
  });

  it("stop() 只解除計時器、不清空檔案；重啟後恢復", async () => {
    const s1 = new SendScheduler(async () => {}, async () => {});
    const v = s1.add([], Date.now() - 1000, "*/5 * * * *", {
      skillId: "rss",
      task: "poll",
      chat: "c2",
      args: {},
      state: { x: 1 },
    });
    s1.stop();

    const s2 = new SendScheduler(async () => {}, async () => {});
    const found = s2.list().find((j) => j.id === v.id);
    assert.ok(found?.skillTask);
    assert.equal(found?.skillTask?.task, "poll");
    s2.cancel(v.id);
    s2.stop();
    assert.equal(s2.list().length, 0);
  });

  it("無 onSkillTask 時略過但照樣推進（不熱迴圈）", async () => {
    const s = new SendScheduler(async () => {
      throw new Error("nope");
    });
    const v = s.add([], Date.now() - 1000, "* * * * *", {
      skillId: "x",
      task: "y",
      chat: "c",
      args: {},
      state: {},
    });
    await sleep(1200);
    const job = s.list().find((j) => j.id === v.id);
    assert.ok(job && new Date(job.runAt).getTime() > Date.now());
    s.cancel(v.id);
    s.stop();
  });

  it("技能任務也需要 repeat", () => {
    const s = new SendScheduler(async () => {}, async () => {});
    assert.throws(
      () =>
        s.add([], Date.now() + 1000, undefined, {
          skillId: "x",
          task: "y",
          chat: "c",
          args: {},
          state: {},
        }),
      /repeat/,
    );
    s.stop();
  });
});
