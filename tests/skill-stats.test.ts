import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import {
  flushSkillStats,
  getSkillJournals,
  getSkillUsage,
  recordSkillRun,
  resetSkillStatsCache,
  setSkillStatsPath,
} from "../src/skill-stats.js";
import { formatInTz } from "../src/time.js";

const today = formatInTz(new Date()).slice(0, 10);

function freshPath(tag: string): string {
  const p = join(tmpdir(), `skill-stats-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  resetSkillStatsCache();
  setSkillStatsPath(p);
  return p;
}

describe("skill-stats 執行日誌", () => {
  it("成功：計數／lastOk／連敗歸零／今日桶", () => {
    freshPath("ok");
    const j = recordSkillRun("lunar", true);
    assert.equal(j.totalRun, 1);
    assert.equal(j.totalFail, 0);
    assert.equal(j.lastOk, true);
    assert.equal(j.consecFails, 0);
    assert.ok(typeof j.lastAt === "number");
    assert.ok(typeof j.lastSuccessAt === "number");
    assert.equal(j.lastError, undefined);
    assert.equal(j.days.length, 1);
    assert.equal(j.days[0].date, today);
    assert.deepEqual([j.days[0].run, j.days[0].fail], [1, 0]);
  });

  it("失敗：連敗累加＋錯因截斷 200 字", () => {
    freshPath("fail");
    recordSkillRun("stock", false, "a".repeat(300));
    const j = recordSkillRun("stock", false, "boom");
    assert.equal(j.totalRun, 2);
    assert.equal(j.totalFail, 2);
    assert.equal(j.lastOk, false);
    assert.equal(j.consecFails, 2);
    assert.equal(j.lastError, "boom");
    assert.equal(j.lastSuccessAt, null);
    assert.equal(j.days[0].fail, 2);
    const j2 = recordSkillRun("stock", false, "b".repeat(500));
    assert.equal(j2.lastError?.length, 200);
  });

  it("成功會清掉連敗與錯因", () => {
    freshPath("recover");
    recordSkillRun("bus", false, "tdx 401");
    const j = recordSkillRun("bus", true);
    assert.equal(j.consecFails, 0);
    assert.equal(j.lastError, undefined);
    assert.equal(j.lastOk, true);
  });

  it("flush 落檔＋重載一致（防抖平時不寫檔）", () => {
    const p = freshPath("persist");
    recordSkillRun("lunar", true);
    assert.equal(existsSync(p), false);
    flushSkillStats();
    assert.equal(existsSync(p), true);
    resetSkillStatsCache();
    const journals = getSkillJournals();
    assert.equal(journals.lunar.totalRun, 1);
    assert.equal(journals.lunar.days[0].date, today);
  });

  it("損壞檔案回空表不炸", () => {
    const p = freshPath("corrupt");
    writeFileSync(p, "{not json", "utf8");
    assert.deepEqual(getSkillJournals(), {});
    assert.deepEqual(getSkillUsage(), []);
  });

  it("天數上限 8 天＋usage 只算近 7 日", () => {
    const p = freshPath("prune");
    const days = [];
    for (let i = 0; i < 10; i++) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      days.push({ date: d, run: 1, fail: i === 9 ? 1 : 0 });
    }
    writeFileSync(
      p,
      JSON.stringify({ skills: { old: { totalRun: 10, totalFail: 1, lastAt: 1, lastOk: true, consecFails: 0, lastSuccessAt: 1, days } } }),
      "utf8",
    );
    const journals = getSkillJournals();
    assert.ok(journals.old.days.length <= 8);
    const usage = getSkillUsage();
    const row = usage.find((r) => r.id === "old")!;
    // 10 天前那筆（i=9，fail=1）應被裁掉或排除在 7 日外
    assert.ok(row.runs7d <= 7);
    assert.equal(row.fails7d, 0);
    assert.equal(row.totalRuns, 10);
    assert.equal(row.failRate, 0);
  });

  it("usage 失敗率一位小數", () => {
    freshPath("rate");
    recordSkillRun("x", true);
    recordSkillRun("x", false, "e");
    recordSkillRun("x", false, "e");
    const row = getSkillUsage().find((r) => r.id === "x")!;
    assert.equal(row.runs7d, 3);
    assert.equal(row.fails7d, 2);
    assert.equal(row.failRate, 66.7);
  });
});
