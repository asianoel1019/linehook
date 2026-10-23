import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { nowInTz } from "../src/time.js";
import { dispatchSkillTask, parseQuietWindow, isQuietMinutes, quietEndMs, type DispatchDeps } from "../src/messaging/dispatch.js";
import { loadSkills } from "../src/skills/loader.js";
import {
  setSchedulesMetaPath,
  loadSchedulesMeta,
  setQuietHours,
  setGlobalMute,
  setJobMuted,
  recordLastRun,
  pruneSchedulesMeta,
} from "../src/schedules-meta.js";

await loadSkills();

const savedSkills = [...config.skills];
const metaFile = join(tmpdir(), `sched-meta-test-${process.pid}.json`);

beforeEach(() => {
  setSchedulesMetaPath(metaFile);
  config.skills = [{ id: "remind", enabled: true, trigger: "", allowedUsers: [], config: {} }];
  // meta 共用同一檔：每測重置（勿擾/靜音/lastRun 不得外洩）
  setQuietHours({ enabled: false, from: "23:00", to: "07:00" });
  setGlobalMute(false);
  pruneSchedulesMeta(new Set());
});

afterEach(() => {
  config.skills = [...savedSkills];
  setSchedulesMetaPath(null);
});

function makeDeps(over: Partial<DispatchDeps> = {}): DispatchDeps & { replies: string[]; updates: Array<{ id: string; patch: unknown }> } {
  const replies: string[] = [];
  const updates: Array<{ id: string; patch: unknown }> = [];
  return {
    replies,
    updates,
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
    updateScheduledTask: ((id: string, patch: unknown) => {
      updates.push({ id, patch });
      return { id } as never;
    }) as DispatchDeps["updateScheduledTask"],
    enqueueText: async () => {},
    getQueueStats: () => ({ pending: 0, running: false }),
    listScheduled: () => [],
    ...over,
  };
}

function job(extra: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    runAt: Date.now(),
    inputs: [],
    to: ["c1"],
    summary: "技能任務：remind/daily",
    repeat: "0 8 * * *",
    createdAt: Date.now(),
    skillTask: { skillId: "remind", task: "daily", chat: "c1", args: { text: "吃藥" }, state: {} },
    ...extra,
  } as never;
}

/** 以台北牆鐘構造覆蓋此刻的勿擾窗口（前1h～後1h）。 */
function quietCoveringNow(): { from: string; to: string } {
  const now = nowInTz();
  const wall = now.getHours() * 60 + now.getMinutes();
  const fmt = (m: number): string => {
    const n = ((m % 1440) + 1440) % 1440;
    return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  };
  return { from: fmt(wall - 60), to: fmt(wall + 60) };
}

describe("schedules-meta 存储", () => {
  it("預設值與寫入讀回", () => {
    const d = loadSchedulesMeta();
    assert.equal(d.globalMute, false);
    assert.equal(d.quiet.enabled, false);
    setQuietHours({ enabled: true, from: "23:00", to: "07:00" });
    setGlobalMute(true);
    setJobMuted("j1", true);
    recordLastRun("j1", { at: 123, ok: true });
    const r = loadSchedulesMeta();
    assert.equal(r.quiet.enabled, true);
    assert.equal(r.globalMute, true);
    assert.equal(r.muted.j1, true);
    assert.deepEqual(r.lastRuns.j1, { at: 123, ok: true });
    setJobMuted("j1", false);
    assert.equal(loadSchedulesMeta().muted.j1, undefined);
  });

  it("壞資料正規化（壞時間回預設）", () => {
    setQuietHours({ enabled: true, from: "xx", to: "" } as never);
    const r = loadSchedulesMeta();
    assert.equal(r.quiet.from, "23:00");
    assert.equal(r.quiet.to, "07:00");
  });

  it("prune 清掉消失的任務", () => {
    setJobMuted("gone", true);
    recordLastRun("gone", { at: 1, ok: true });
    recordLastRun("alive", { at: 2, ok: false, error: "x" });
    pruneSchedulesMeta(new Set(["alive"]));
    const r = loadSchedulesMeta();
    assert.equal(r.muted.gone, undefined);
    assert.equal(r.lastRuns.gone, undefined);
    assert.equal(r.lastRuns.alive.ok, false);
  });
});

describe("quiet 純函式", () => {
  it("parseQuietWindow：合法／非法／等值", () => {
    assert.deepEqual(parseQuietWindow("23:00", "07:00"), { fromMin: 1380, toMin: 420 });
    assert.equal(parseQuietWindow("09:00", "09:00"), null);
    assert.equal(parseQuietWindow("xx", "07:00"), null);
    assert.equal(parseQuietWindow("9：05", "10:00")?.fromMin, 545);
  });

  it("isQuietMinutes：日間與跨夜邊界", () => {
    const day = { fromMin: 540, toMin: 1020 };
    assert.equal(isQuietMinutes(539, day), false);
    assert.equal(isQuietMinutes(540, day), true);
    assert.equal(isQuietMinutes(1019, day), true);
    assert.equal(isQuietMinutes(1020, day), false);
    const night = { fromMin: 1380, toMin: 420 };
    assert.equal(isQuietMinutes(1379, night), false);
    assert.equal(isQuietMinutes(1380, night), true);
    assert.equal(isQuietMinutes(0, night), true);
    assert.equal(isQuietMinutes(419, night), true);
    assert.equal(isQuietMinutes(420, night), false);
  });

  it("quietEndMs：當天與跨日", () => {
    const parts = { year: 2026, month: 10, day: 23 };
    const night = { fromMin: 1380, toMin: 420 };
    // 10/23 15:00Z（23:00+08）→ 結束於 10/23 23:00Z（隔天 07:00+08）
    assert.equal(
      new Date(quietEndMs(Date.UTC(2026, 9, 23, 15, 0), parts, night, "Asia/Taipei")).toISOString(),
      "2026-10-23T23:00:00.000Z",
    );
    // 清晨 06:00+08（窗口內）→ 結束於當天 07:00+08 = 10/22 23:00Z
    assert.equal(
      new Date(quietEndMs(Date.UTC(2026, 9, 22, 22, 0), parts, night, "Asia/Taipei")).toISOString(),
      "2026-10-22T23:00:00.000Z",
    );
  });
});

describe("dispatchSkillTask 推播總管", () => {
  it("全域靜音略過（不執行、不記 lastRun）", async () => {
    setGlobalMute(true);
    const d = makeDeps();
    await dispatchSkillTask(job(), d);
    assert.deepEqual(d.replies, []);
    assert.equal(loadSchedulesMeta().lastRuns["job-1"], undefined);
  });

  it("單一靜音略過", async () => {
    setJobMuted("job-1", true);
    const d = makeDeps();
    await dispatchSkillTask(job(), d);
    assert.deepEqual(d.replies, []);
    setJobMuted("job-1", false);
  });

  it("勿擾時段改期到結束（不執行）", async () => {
    const q = quietCoveringNow();
    setQuietHours({ enabled: true, from: q.from, to: q.to });
    const d = makeDeps();
    await dispatchSkillTask(job(), d);
    assert.deepEqual(d.replies, []);
    assert.equal(d.updates.length, 1);
    const runAt = (d.updates[0].patch as { runAt: number }).runAt;
    assert.ok(runAt > Date.now(), "改期到未來");
    assert.equal(loadSchedulesMeta().lastRuns["job-1"], undefined);
  });

  it("無改期能力時照常執行並 warn（不丟失）", async () => {
    const q = quietCoveringNow();
    setQuietHours({ enabled: true, from: q.from, to: q.to });
    const d = makeDeps({ updateScheduledTask: undefined });
    await dispatchSkillTask(job(), d);
    assert.equal(d.replies.length, 1);
    assert.match(d.replies[0], /吃藥/);
  });

  it("正常執行記 lastRun ok", async () => {
    const d = makeDeps();
    await dispatchSkillTask(job(), d);
    assert.equal(d.replies.length, 1);
    assert.equal(loadSchedulesMeta().lastRuns["job-1"]?.ok, true);
  });

  it("執行炸掉記 lastRun fail", async () => {
    const d = makeDeps({
      replyTo: async () => {
        throw new Error("boom");
      },
    });
    await dispatchSkillTask(job(), d);
    const last = loadSchedulesMeta().lastRuns["job-1"];
    assert.equal(last?.ok, false);
    assert.match(last?.error ?? "", /boom/);
  });
});
