import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  buildHolidayMap,
  dayStatus,
  nextOffSpan,
  parseIcs,
  parseMakeupDays,
} from "../src/skills/holiday/index.js";

describe("holiday parseIcs", () => {
  const ICS = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20261010",
    "DTEND;VALUE=DATE:20261011",
    "SUMMARY:國慶日（雙十節）",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20261231",
    "DTEND;VALUE=DATE:20270104",
    "SUMMARY:元旦連假",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("解析全天事件，DTEND 為隔天", () => {
    const events = parseIcs(ICS);
    assert.equal(events.length, 2);
    assert.equal(events[0].start, "2026-10-10");
    assert.equal(events[0].end, "2026-10-11");
    assert.equal(events[0].summary, "國慶日（雙十節）");
  });

  it("展開續行（折行以空格開頭）", () => {
    const folded = ["BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260606", "SUMMARY:端午節連", " 假", "END:VEVENT"].join(
      "\r\n",
    );
    const events = parseIcs(folded);
    assert.equal(events[0].summary, "端午節連假");
  });

  it("跨年多日事件涵蓋每一天", () => {
    const map = buildHolidayMap(parseIcs(ICS));
    assert.equal(map.get("2026-12-31"), "元旦連假");
    assert.equal(map.get("2027-01-01"), "元旦連假");
    assert.equal(map.get("2027-01-03"), "元旦連假");
    assert.equal(map.has("2027-01-04"), false, "DTEND 為不含當天");
  });

  it("壞行不算事件（無 DTSTART 略過）", () => {
    assert.deepEqual(parseIcs("BEGIN:VEVENT\nSUMMARY:沒日期\nEND:VEVENT"), []);
  });
});

describe("holiday dayStatus", () => {
  const holidays = buildHolidayMap([
    { start: "2026-10-10", end: "2026-10-11", summary: "國慶日" },
    { start: "2026-10-12", end: "2026-10-13", summary: "補假日" },
  ]);

  it("國定假日放假", () => {
    const st = dayStatus("2026-10-10", holidays, new Set());
    assert.equal(st.off, true);
    assert.equal(st.reason, "holiday");
    assert.equal(st.name, "國慶日");
  });

  it("週末放假", () => {
    // 2026-10-10 是週六；取 2026-10-11（週日）驗證
    const st = dayStatus("2026-10-11", holidays, new Set());
    assert.equal(st.off, true);
    assert.equal(st.reason, "weekend");
  });

  it("平日要上班", () => {
    const st = dayStatus("2026-10-13", holidays, new Set()); // 週二，非假日
    assert.equal(st.off, false);
  });

  it("補班日壓過假日與週末（要上班）", () => {
    const st = dayStatus("2026-10-10", holidays, new Set(["2026-10-10"]));
    assert.equal(st.off, false);
    assert.equal(st.reason, "makeup");
  });
});

describe("holiday nextOffSpan", () => {
  it("找出含週末的三連假", () => {
    // 2026-10-09（五）之後是六、日，加上 10/10、10/12 兩個假日 → 10/10–10/12 三連假
    const holidays = buildHolidayMap([
      { start: "2026-10-10", end: "2026-10-11", summary: "國慶日" },
      { start: "2026-10-12", end: "2026-10-13", summary: "補假日" },
    ]);
    const span = nextOffSpan("2026-10-09", holidays, new Set());
    assert.ok(span);
    assert.equal(span?.from, "2026-10-10");
    assert.equal(span?.to, "2026-10-12");
    assert.equal(span?.days, 3);
    assert.ok(span?.names.includes("國慶日"));
  });

  it("週五晚上起算，連假從隔天開始算進去", () => {
    const span = nextOffSpan("2026-10-09", new Map(), new Set());
    // 10/10（六）10/11（日）為週末
    assert.equal(span?.from, "2026-10-10");
    assert.equal(span?.to, "2026-10-11");
    assert.equal(span?.days, 2);
  });
});

describe("holiday parseMakeupDays", () => {
  it("支援 YYYY-MM-DD 與 M/D（補年份）", () => {
    const set = parseMakeupDays("2026-02-28, 6/6、2027-01-08");
    assert.ok(set.has("2026-02-28"));
    assert.ok(set.has("2027-01-08"));
    assert.equal(
      [...set].some((d) => /-\d{2}-\d{2}$/.test(d) && d.startsWith("2026-") && d.endsWith("-06-06")),
      true,
    );
  });

  it("空值回空集合", () => {
    assert.equal(parseMakeupDays("").size, 0);
    assert.equal(parseMakeupDays(undefined).size, 0);
    assert.equal(parseMakeupDays("垃圾輸入").size, 0);
  });
});

describe("holiday addDays", () => {
  it("跨月跨年正確", () => {
    assert.equal(addDays("2026-01-31", 1), "2026-02-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });
});
