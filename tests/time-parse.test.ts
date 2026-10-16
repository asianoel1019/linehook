import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zonedTimeToMs } from "../src/time.js";
import {
  chineseNumToInt,
  parseDateOnly,
  parseDateTime,
} from "../src/skills/time-parse.js";
import { parseWhen } from "../src/skills/remind/index.js";
import { parseItem } from "../src/skills/countdown/index.js";
import { renderList } from "../src/skills/todo/index.js";

const TZ = "Asia/Taipei";
// 本地時間 2026-10-15（週四）10:00；NOW_MS 為同一牆鐘在台北的瞬間（與進程時區無關）。
const NOW = new Date(2026, 9, 15, 10, 0, 0);
const NOW_MS = zonedTimeToMs({ year: 2026, month: 10, day: 15, hour: 10, minute: 0 }, TZ);
const OPTS = { now: NOW, nowMs: NOW_MS, timeZone: TZ };
const iso = (ms: number): string => new Date(ms).toISOString();

describe("chineseNumToInt", () => {
  it("阿拉伯與中文數字", () => {
    assert.equal(chineseNumToInt("3"), 3);
    assert.equal(chineseNumToInt("三"), 3);
    assert.equal(chineseNumToInt("兩"), 2);
    assert.equal(chineseNumToInt("十"), 10);
    assert.equal(chineseNumToInt("十二"), 12);
    assert.equal(chineseNumToInt("二十五"), 25);
    assert.equal(chineseNumToInt("三十一"), 31);
    assert.equal(chineseNumToInt("abc"), null);
  });
});

describe("parseDateTime（共用解析器）", () => {
  it("相對時間", () => {
    const r = parseDateTime("30分鐘後 喝水", OPTS);
    assert.equal(r?.runAt, NOW_MS + 30 * 60_000);
    assert.deepEqual(r?.matched, ["30分鐘後"]);
  });

  it("今天／明天／後天／大後天", () => {
    assert.equal(iso(parseDateTime("明天 09:00 開會", OPTS)!.runAt), "2026-10-16T01:00:00.000Z");
    assert.equal(iso(parseDateTime("大後天 喝水", OPTS)!.runAt), "2026-10-18T01:00:00.000Z");
  });

  it("下週一／星期五", () => {
    assert.equal(iso(parseDateTime("下週一 09:00 開會", OPTS)!.runAt), "2026-10-19T01:00:00.000Z");
    assert.equal(iso(parseDateTime("星期五 09:00 開會", OPTS)!.runAt), "2026-10-16T01:00:00.000Z");
  });

  it("X月X日過期走次年；M/D 同理；未來走今年", () => {
    assert.equal(iso(parseDateTime("10月5日 聚餐", OPTS)!.runAt), "2027-10-05T01:00:00.000Z");
    assert.equal(iso(parseDateTime("10/5 聚餐", OPTS)!.runAt), "2027-10-05T01:00:00.000Z");
    assert.equal(iso(parseDateTime("12/31 跨年", OPTS)!.runAt), "2026-12-31T01:00:00.000Z");
  });

  it("時段詞＋X點（半）", () => {
    assert.equal(iso(parseDateTime("下午三點半 喝水", OPTS)!.runAt), "2026-10-15T07:30:00.000Z");
    assert.equal(iso(parseDateTime("中午12點 吃飯", OPTS)!.runAt), "2026-10-15T04:00:00.000Z");
    assert.equal(iso(parseDateTime("下午 3:30 開會", OPTS)!.runAt), "2026-10-15T07:30:00.000Z");
  });

  it("裸 X點取下一個未來時刻", () => {
    assert.equal(iso(parseDateTime("9點 開會", OPTS)!.runAt), "2026-10-15T13:00:00.000Z");
    assert.equal(iso(parseDateTime("11點 開會", OPTS)!.runAt), "2026-10-15T03:00:00.000Z");
    assert.equal(iso(parseDateTime("3點 開會", OPTS)!.runAt), "2026-10-15T07:00:00.000Z");
  });

  it("凌晨12點是隔天 00:00", () => {
    assert.equal(iso(parseDateTime("凌晨12點 起床", OPTS)!.runAt), "2026-10-15T16:00:00.000Z");
  });

  it("matched 供內容剝除", () => {
    const r = parseDateTime("下週一 09:00 開會", OPTS);
    assert.ok(r?.matched.includes("下週一"));
    assert.ok(r?.matched.includes("09:00"));
  });

  it("無效輸入回 null", () => {
    assert.equal(parseDateTime("昨天吃飯了", OPTS), null);
    assert.equal(parseDateTime("25點開會", OPTS), null);
    assert.equal(parseDateTime("13:99 開會", OPTS), null);
    assert.equal(parseDateTime("買牛奶", OPTS), null);
  });
});

describe("parseDateOnly", () => {
  it("買牛奶 明天", () => {
    const r = parseDateOnly("買牛奶 明天", { now: NOW });
    assert.equal(r?.ymd, "2026-10-16");
    assert.equal(r?.matched, "明天");
  });
});

describe("remind parseWhen（委派共用解析器）", () => {
  it("下週一與下午三點半", () => {
    const r = parseWhen("下週一 09:00 開會");
    assert.ok(!("error" in r));
    if (!("error" in r)) {
      assert.ok(r.matched.includes("下週一"));
    }
    const p = parseWhen("下午三點半 喝水");
    assert.ok(!("error" in p));
  });

  it("無法解析回 error", () => {
    assert.ok("error" in parseWhen("亂七八糟"));
  });
});

describe("countdown parseItem 中文月日", () => {
  const now = new Date(2026, 9, 10);
  it("每年 10月5日", () => {
    const it1 = parseItem("每年 10月5日 結婚", now);
    assert.equal(it1?.date, "10-05");
    assert.equal(it1?.yearly, true);
    assert.equal(it1?.label, "結婚");
  });

  it("十月五日（中文數字）", () => {
    const it1 = parseItem("十月五日 聚餐", now);
    assert.equal(it1?.date, "10-05");
  });
});

describe("todo renderList 到期顯示", () => {
  it("未來顯示到期、過去顯示逾期、無期限維持原樣", () => {
    const s = renderList(
      [
        { id: 1, text: "未來", done: false, by: "", createdAt: 0, due: "2026-12-31" },
        { id: 2, text: "過去", done: false, by: "", createdAt: 0, due: "2026-01-01" },
        { id: 3, text: "普通", done: false, by: "", createdAt: 0 },
      ],
      "2026-10-15",
    );
    assert.ok(s.includes("未來（12/31到期）"));
    assert.ok(s.includes("過去（逾期 01/01！）"));
    assert.ok(s.includes("3. ▫ 普通"));
  });
});
