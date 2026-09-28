import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCron, nextRun } from "../src/line/cron.js";

describe("parseCron", () => {
  it("解析合法的 5 欄 cron", () => {
    const c = parseCron("0 9 * * 1-5");
    assert.deepEqual([...c.minutes], [0]);
    assert.deepEqual([...c.hours], [9]);
    assert.equal(c.domRestricted, false);
    assert.equal(c.dowRestricted, true);
  });

  it("週日 7 正規化為 0", () => {
    const c = parseCron("0 0 * * 7");
    assert.ok(c.weekdays.has(0));
    assert.ok(!c.weekdays.has(7));
  });

  it("欄數錯誤丟錯", () => {
    assert.throws(() => parseCron("0 9 * *"), /5 欄/);
  });

  it("超出範圍的明確數值丟錯（不靜默變 *）", () => {
    assert.throws(() => parseCron("65 * * * *"), /範圍/);
    assert.throws(() => parseCron("0 25 * * *"), /範圍/);
    assert.throws(() => parseCron("0 0 32 * *"), /範圍/);
  });

  it("步進 interval 非正整數丟錯", () => {
    assert.throws(() => parseCron("*/0 * * * *"), /間隔/);
  });
});

describe("nextRun", () => {
  it("每天 09:00（台北時區）回傳台北牆鐘 09:00", () => {
    const c = parseCron("0 9 * * *");
    const n = nextRun(c, Date.now(), "Asia/Taipei");
    assert.ok(n !== null);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(n));
    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    assert.equal(get("hour"), "09");
    assert.equal(get("minute"), "00");
    assert.ok(n > Date.now());
  });

  it("不可能的日期（2/30）回傳 null", () => {
    const c = parseCron("0 0 30 2 *");
    assert.equal(nextRun(c, Date.now(), "Asia/Taipei"), null);
  });

  it("無時區參數時仍可用（伺服器本地時間）", () => {
    const c = parseCron("* * * * *");
    const n = nextRun(c, Date.now());
    assert.ok(n !== null && n > Date.now());
  });
});
