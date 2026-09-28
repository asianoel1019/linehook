import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDateTimeInTz, zonedTimeToMs, tzOffsetMs, formatInTz } from "../src/time.js";

describe("parseDateTimeInTz", () => {
  it("2026-09-28 09:00（台北）= 01:00Z", () => {
    const ms = parseDateTimeInTz("2026-09-28 09:00", "Asia/Taipei");
    assert.equal(new Date(ms).toISOString(), "2026-09-28T01:00:00.000Z");
  });

  it("含秒格式", () => {
    const ms = parseDateTimeInTz("2026-09-28 09:00:30", "Asia/Taipei");
    assert.equal(new Date(ms).toISOString(), "2026-09-28T01:00:30.000Z");
  });

  it("UTC 時區無偏移", () => {
    const ms = parseDateTimeInTz("2026-09-28 09:00", "UTC");
    assert.equal(new Date(ms).toISOString(), "2026-09-28T09:00:00.000Z");
  });

  it("格式錯誤回 null", () => {
    assert.equal(parseDateTimeInTz("明天早上", "Asia/Taipei"), null);
  });
});

describe("zonedTimeToMs / tzOffsetMs 互逆", () => {
  it("台北 2026-01-01 00:00 偏移為 +8h", () => {
    const off = tzOffsetMs("Asia/Taipei", Date.UTC(2026, 0, 1));
    assert.equal(off, 8 * 3600 * 1000);
  });

  it("往返一致", () => {
    const ms = zonedTimeToMs(
      { year: 2026, month: 9, day: 28, hour: 9, minute: 30 },
      "Asia/Taipei",
    );
    assert.equal(new Date(ms).toISOString(), "2026-09-28T01:30:00.000Z");
  });
});

describe("formatInTz", () => {
  it("台北輸出帶 +08:00", () => {
    const s = formatInTz(new Date(Date.UTC(2026, 8, 28, 1, 0, 0)), "Asia/Taipei");
    assert.ok(s.startsWith("2026-09-28T09:00:00+08:00"), s);
  });
});
