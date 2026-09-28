import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  solarToLunar,
  lunarToSolar,
  monthDays,
  leapMonth,
  dayName,
  monthName,
  ganzhi,
  zodiac,
} from "../src/skills/lunar/index.js";

describe("solarToLunar 已知春節", () => {
  it("2026-02-17 是丙午年正月初一（馬）", () => {
    const l = solarToLunar(2026, 2, 17);
    assert.deepEqual(l, { year: 2026, month: 1, day: 1, isLeap: false });
    assert.equal(ganzhi(2026), "丙午");
    assert.equal(zodiac(2026), "馬");
  });

  it("2024-02-10 是甲辰年正月初一（龍）", () => {
    const l = solarToLunar(2024, 2, 10);
    assert.deepEqual(l, { year: 2024, month: 1, day: 1, isLeap: false });
    assert.equal(ganzhi(2024), "甲辰");
    assert.equal(zodiac(2024), "龍");
  });

  it("2025-01-29 是乙巳年正月初一（蛇）", () => {
    const l = solarToLunar(2025, 1, 29);
    assert.deepEqual(l, { year: 2025, month: 1, day: 1, isLeap: false });
    assert.equal(ganzhi(2025), "乙巳");
    assert.equal(zodiac(2025), "蛇");
  });
});

describe("農曆往返一致性", () => {
  const dates: Array<[number, number, number]> = [
    [2026, 9, 28],
    [2026, 2, 17],
    [2024, 2, 10],
    [2025, 1, 29],
    [2023, 6, 15],
    [2030, 12, 31],
    [2000, 1, 1],
  ];
  for (const [y, m, d] of dates) {
    it(`${y}-${m}-${d} 往返一致`, () => {
      const l = solarToLunar(y, m, d);
      const back = lunarToSolar(l);
      assert.equal(back.getUTCFullYear(), y);
      assert.equal(back.getUTCMonth() + 1, m);
      assert.equal(back.getUTCDate(), d);
    });
  }

  it("2026 八月初七 ↔ 2026-09-17", () => {
    const back = lunarToSolar({ year: 2026, month: 8, day: 7, isLeap: false });
    assert.equal(back.getUTCFullYear(), 2026);
    assert.equal(back.getUTCMonth() + 1, 9);
    assert.equal(back.getUTCDate(), 17);
  });
});

describe("閏月", () => {
  it("2025 有閏六月", () => {
    assert.equal(leapMonth(2025), 6);
  });

  it("閏六月初三 2025 ↔ 2025-07-27", () => {
    const back = lunarToSolar({ year: 2025, month: 6, day: 3, isLeap: true });
    assert.equal(back.getUTCFullYear(), 2025);
    assert.equal(back.getUTCMonth() + 1, 7);
    assert.equal(back.getUTCDate(), 27);
  });

  it("每月天數為 29 或 30", () => {
    for (let m = 1; m <= 12; m++) {
      const d = monthDays(2026, m);
      assert.ok(d === 29 || d === 30, `month ${m}: ${d}`);
    }
  });
});

describe("名稱格式", () => {
  it("dayName", () => {
    assert.equal(dayName(1), "初一");
    assert.equal(dayName(9), "初九");
    assert.equal(dayName(10), "初十");
    assert.equal(dayName(15), "十五");
    assert.equal(dayName(20), "二十");
    assert.equal(dayName(21), "廿一");
    assert.equal(dayName(29), "廿九");
    assert.equal(dayName(30), "三十");
  });

  it("monthName", () => {
    assert.equal(monthName(1, false), "正月");
    assert.equal(monthName(8, false), "八月");
    assert.equal(monthName(6, true), "閏六月");
  });
});
