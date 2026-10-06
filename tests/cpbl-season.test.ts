import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CUTOFFS,
  detectSeasonSegment,
  deriveSecondHalf,
  formatGb,
  parseCutoffs,
  resolveSeasonSegment,
  type StandingRow,
} from "../src/skills/cpbl/index.js";

function row(team: string, record: string, games: number, rank = ""): StandingRow {
  return { rank, team, record, pct: "", gb: "", games };
}

/** 2026-10-06 實測的兩張 zxc 表（全年度 / 上半季）。 */
const FULL: StandingRow[] = [
  row("味全龍", "67-53-0", 120),
  row("統一7-ELEVEn獅", "64-55-1", 120),
  row("富邦悍將", "58-61-0", 119),
  row("樂天桃猿", "57-60-2", 119),
  row("中信兄弟", "56-62-2", 120),
  row("台鋼雄鷹", "54-65-1", 120),
];
const FIRST: StandingRow[] = [
  row("味全龍", "39-21-0", 60),
  row("富邦悍將", "34-26-0", 60),
  row("台鋼雄鷹", "30-29-1", 60),
  row("統一7-ELEVEn獅", "30-29-1", 60),
  row("樂天桃猿", "24-34-2", 60),
  row("中信兄弟", "20-38-2", 60),
];

describe("cpbl 賽季切點", () => {
  it("parseCutoffs 預設值", () => {
    assert.deepEqual(parseCutoffs(undefined), DEFAULT_CUTOFFS.split(","));
    assert.deepEqual(parseCutoffs(""), DEFAULT_CUTOFFS.split(","));
  });

  it("parseCutoffs 可覆寫且會補零", () => {
    assert.deepEqual(parseCutoffs("3-20,7/1,10-10,11-20"), ["03-20", "07-01", "10-10", "11-20"]);
    assert.deepEqual(parseCutoffs("3-20,亂寫"), ["03-20", "07-06", "10-10", "11-15"]);
    assert.deepEqual(parseCutoffs("03-20,07-01,10-10,11-20,01-01"), ["03-20", "07-01", "10-10", "11-20"]);
  });

  it("detectSeasonSegment 依日期分段（預設切點）", () => {
    const cases: Array<[string, string]> = [
      ["01-01", "full"],
      ["03-14", "full"],
      ["03-15", "first"],
      ["07-06", "first"],
      ["07-07", "second"],
      ["10-10", "second"],
      ["10-11", "postseason"],
      ["11-15", "postseason"],
      ["11-16", "full"],
      ["12-31", "full"],
    ];
    for (const [md, expected] of cases) {
      assert.equal(detectSeasonSegment(md), expected, `${md} 應為 ${expected}`);
    }
  });

  it("detectSeasonSegment 吃自訂切點", () => {
    const cutoffs = parseCutoffs("03-25,07-15,10-15,11-30");
    assert.equal(detectSeasonSegment("03-24", cutoffs), "full");
    assert.equal(detectSeasonSegment("03-25", cutoffs), "first");
    assert.equal(detectSeasonSegment("07-16", cutoffs), "second");
    assert.equal(detectSeasonSegment("10-16", cutoffs), "postseason");
    assert.equal(detectSeasonSegment("12-01", cutoffs), "full");
  });
});

describe("formatGb（勝差欄格式化）", () => {
  it("數值原樣、空值與站方佔位符一律顯示 -", () => {
    assert.equal(formatGb(""), "-");
    assert.equal(formatGb("-"), "-");
    assert.equal(formatGb("---"), "-");
    assert.equal(formatGb("5"), "5");
    assert.equal(formatGb("11.5"), "11.5");
    assert.equal(formatGb("2.5 "), "2.5");
  });

  it("站方放在勝差欄的特殊標記改用 -（標記） 呈現", () => {
    assert.equal(formatGb("封 王"), "-（封王）");
    assert.equal(formatGb("封王"), "-（封王）");
  });
});

describe("cpbl 指令參數覆寫", () => {
  const cutoffs = parseCutoffs();

  it("明確參數優先於日期", () => {
    // 日期落在季後賽期間，但使用者指名下半季
    assert.equal(resolveSeasonSegment("中職 下半季", "10-20", cutoffs), "second");
    assert.equal(resolveSeasonSegment("中職 上半季", "10-20", cutoffs), "first");
    assert.equal(resolveSeasonSegment("中職 全年度", "06-01", cutoffs), "full");
    assert.equal(resolveSeasonSegment("中職 季後賽", "06-01", cutoffs), "postseason");
  });

  it("沒有參數時依日期", () => {
    assert.equal(resolveSeasonSegment("", "10-01", cutoffs), "second");
    assert.equal(resolveSeasonSegment("味全龍", "10-01", cutoffs), "second");
    assert.equal(resolveSeasonSegment("today", "05-01", cutoffs), "first");
  });

  it("別名與英文關鍵字", () => {
    assert.equal(resolveSeasonSegment("全季", "05-01", cutoffs), "full");
    assert.equal(resolveSeasonSegment("總冠軍賽", "05-01", cutoffs), "postseason");
    assert.equal(resolveSeasonSegment("second half", "05-01", cutoffs), "second");
  });
});

describe("deriveSecondHalf（下半季＝全年度−上半季）", () => {
  const second = deriveSecondHalf(FULL, FIRST);

  it("每隊都推算得到", () => {
    assert.equal(second.length, FULL.length);
    assert.deepEqual(
      second.map((r) => r.team).sort(),
      FULL.map((r) => r.team).sort(),
    );
  });

  it("戰績為兩表相減", () => {
    const byTeam = new Map(second.map((r) => [r.team, r]));
    assert.equal(byTeam.get("中信兄弟")?.record, "36-24-0");
    assert.equal(byTeam.get("統一7-ELEVEn獅")?.record, "34-26-0");
    assert.equal(byTeam.get("樂天桃猿")?.record, "33-26-0");
    assert.equal(byTeam.get("味全龍")?.record, "28-32-0");
    assert.equal(byTeam.get("富邦悍將")?.record, "24-35-0");
    assert.equal(byTeam.get("台鋼雄鷹")?.record, "24-36-0");
  });

  it("名次依勝率排序、勝差以第一名為基準", () => {
    assert.deepEqual(
      second.map((r) => r.rank),
      ["1", "2", "3", "4", "5", "6"],
    );
    assert.deepEqual(
      second.map((r) => r.team),
      ["中信兄弟", "統一7-ELEVEn獅", "樂天桃猿", "味全龍", "富邦悍將", "台鋼雄鷹"],
    );
    assert.deepEqual(
      second.map((r) => r.gb),
      ["-", "2", "2.5", "8", "11.5", "12"],
    );
    assert.deepEqual(
      second.map((r) => r.games),
      [60, 60, 59, 60, 59, 60],
    );
  });

  it("勝率以三位小數呈現（去尾零）", () => {
    const byTeam = new Map(second.map((r) => [r.team, r]));
    assert.equal(byTeam.get("中信兄弟")?.pct, "0.6");
    assert.equal(byTeam.get("統一7-ELEVEn獅")?.pct, "0.567");
    assert.equal(byTeam.get("樂天桃猿")?.pct, "0.559");
  });

  it("兩表對不上（出現負數）時跳過該隊而不是算出負戰績", () => {
    const broken = [row("味全龍", "10-90-0", 100)];
    const out = deriveSecondHalf(broken, FIRST);
    assert.equal(out.length, 0);
  });

  it("上半季還沒開打（全年度＝上半季）時不產生 0 場次的列", () => {
    const out = deriveSecondHalf(FIRST, FIRST);
    assert.equal(out.length, 0);
  });
});
