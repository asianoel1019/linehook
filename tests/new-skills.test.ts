import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCoin } from "../src/skills/crypto/index.js";
import { toQuote } from "../src/skills/taiex/index.js";
import { fromUsgs, fromCwa, formatQuake } from "../src/skills/quake/index.js";
import { parseNum, computePercent, matchName, joinStatus } from "../src/skills/reservoir/index.js";
import { filterOutages, formatCase, parseNewsRss } from "../src/skills/outage/index.js";
import { parseTableItems, matchBudget } from "../src/skills/mcdonald/index.js";
import { parseOfficialRows, parseZxcRows, findTeam } from "../src/skills/cpbl/index.js";
import { mergeAvailability, matchCity } from "../src/skills/ybike/index.js";
import { matchOperator, findStationId, formatHeadway } from "../src/skills/metro/index.js";

describe("crypto resolveCoin", () => {
  it("中文名與代碼", () => {
    assert.equal(resolveCoin("比特幣現在多少").id, "bitcoin");
    assert.equal(resolveCoin("ETH").id, "ethereum");
    assert.equal(resolveCoin("狗狗幣").id, "dogecoin");
  });

  it("預設比特幣", () => {
    assert.equal(resolveCoin("").id, "bitcoin");
    assert.equal(resolveCoin("亂七八糟").id, "bitcoin");
  });
});

describe("taiex toQuote", () => {
  it("正常 meta", () => {
    const q = toQuote("^TWII", {
      regularMarketPrice: 48024.6,
      chartPreviousClose: 48156.1,
      regularMarketChangePercent: -0.27,
    });
    assert.ok(q);
    assert.equal(q?.price, 48024.6);
    assert.ok((q?.change ?? 0) < 0);
  });

  it("缺價格回 null", () => {
    assert.equal(toQuote("^TWII", {}), null);
  });
});

describe("quake parsers", () => {
  it("USGS geojson", () => {
    const qs = fromUsgs({
      features: [
        {
          properties: { mag: 5.2, place: "花蓮縣近海", time: 1759000000000, url: "https://x", tsunami: 0 },
          geometry: { coordinates: [121.5, 23.9, 12.3] },
        },
        { properties: { mag: null, time: 1 } },
      ],
    });
    assert.equal(qs.length, 1);
    assert.equal(qs[0].mag, 5.2);
    assert.equal(qs[0].depthKm, 12.3);
    assert.equal(qs[0].source, "USGS");
  });

  it("CWA 防禦性解析（結構不符回空陣列）", () => {
    assert.deepEqual(fromCwa({}), []);
    assert.deepEqual(fromCwa({ records: { Earthquake: "nope" } }), []);
    const qs = fromCwa({
      records: {
        Earthquake: [
          {
            EarthquakeNo: 115,
            OriginTime: "2026-09-28T10:00:00+08:00",
            FocalDepth: 15,
            Epicenter: { Location: "花蓮縣近海" },
            EarthquakeMagnitude: { MagnitudeValue: 5.5 },
          },
        ],
      },
    });
    assert.equal(qs.length, 1);
    assert.equal(qs[0].source, "CWA");
  });

  it("formatQuake 含重點", () => {
    const s = formatQuake({ mag: 6.1, place: "台東", timeMs: 1759000000000, depthKm: 10, url: "", tsunami: true, source: "USGS" });
    assert.ok(s.includes("M6.1") && s.includes("海嘯") && s.includes("深10km"));
  });
});

describe("reservoir helpers", () => {
  it("parseNum 去逗號", () => {
    assert.equal(parseNum("33,347.30"), 33347.3);
    assert.ok(Number.isNaN(parseNum(" … ")));
  });

  it("computePercent", () => {
    assert.ok(Math.abs(computePercent(20517.49, 30900) - 66.4) < 0.1);
    assert.ok(Number.isNaN(computePercent(1, 0)));
  });

  it("matchName 去水庫尾、台臺互通", () => {
    assert.ok(matchName("石門水庫", "石門"));
    assert.ok(matchName("臺北水庫", "台北"));
    assert.ok(!matchName("石門水庫", "曾文"));
  });

  it("joinStatus 合併即時與基本資料", () => {
    const out = joinStatus(
      [{ reservoiridentifier: "10201", observationtime: "2026-09-28T22:00:00", waterlevel: "244.99", effectivewaterstoragecapacity: "20517.49" }],
      [{ 水庫名稱: "石門水庫", 水庫代碼: 10201, 目前有效容量: "30,900" }],
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "石門水庫");
    assert.ok(out[0].pct > 60 && out[0].pct < 70);
  });
});

describe("outage helpers", () => {
  const cases = [
    { 案件日期時間: "2026-09-28 17:00:00", 影響縣市: "臺南市", 影響行政區: "中西區", 停水地區: "府前路", 停水原因: "查修", 區處: "第六區", 影響戶數: "739", 恢復日期時間: "2026-09-29 00:00:00" },
    { 案件日期時間: "2026-09-27 09:00:00", 影響縣市: "高雄市", 影響行政區: "仁武區", 停水地區: "鳳仁路", 停水原因: "破管", 區處: "第七區", 影響戶數: "100", 恢復日期時間: "2026-09-27 17:00:00" },
  ];

  it("filterOutages 排序與關鍵字", () => {
    assert.equal(filterOutages(cases, "").length, 2);
    assert.equal(filterOutages(cases, "高雄")[0].影響縣市, "高雄市");
    assert.equal(filterOutages(cases, "破管").length, 1);
    assert.equal(filterOutages(cases, "台北").length, 0);
  });

  it("formatCase 含重點", () => {
    const s = formatCase(cases[0]);
    assert.ok(s.includes("臺南市中西區") && s.includes("739"));
  });

  it("parseNewsRss", () => {
    const items = parseNewsRss(
      `<rss><channel><item><title>停電通知 - 台電</title><link>https://x</link><pubDate>Sun, 28 Sep 2026 10:00:00 +0800</pubDate><source>台電</source></item></channel></rss>`,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "停電通知");
    assert.equal(items[0].source, "台電");
  });
});

describe("mcdonald parsers", () => {
  const html = `<table><tr><th>餐點品項</th><th>特惠價</th></tr>
<tr><td>大薯</td><td>加1元多1件 66元</td></tr>
<tr><td>中杯可樂</td><td>買1送1 38元</td></tr></table>`;

  it("parseTableItems 跳過表頭、抓價格", () => {
    const items = parseTableItems(html);
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "大薯");
    assert.equal(items[0].price, 66);
    assert.equal(items[1].price, 38);
  });

  it("matchBudget ±30%", () => {
    const items = parseTableItems(html);
    assert.equal(matchBudget(items, 100).length, 0);
    assert.equal(matchBudget(items, 52).length, 2);
  });
});

describe("cpbl parsers", () => {
  const official = `<table><tr><th>排名</th><th>球隊</th><th>出賽</th><th>勝-敗-和</th><th>勝率</th><th>勝差</th></tr>
<tr><td>1</td><td>味全龍</td><td>60</td><td>39-21-0</td><td>0.65</td><td>-</td></tr>
<tr><td>2</td><td>富邦悍將</td><td>60</td><td>34-26-0</td><td>0.567</td><td>5</td></tr></table>`;

  it("parseOfficialRows", () => {
    const rows = parseOfficialRows(official);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].team, "味全龍");
    assert.equal(rows[0].record, "39-21-0");
    assert.equal(rows[1].gb, "5");
  });

  it("parseZxcRows（已解碼文字）", () => {
    const rows = parseZxcRows(
      `<table><tr><td>名次</td><td>球隊</td><td>應賽</td><td>未賽</td><td>已賽</td><td>勝</td><td>敗</td><td>和</td><td>勝率</td><td>勝差</td></tr>
<tr><td>1</td><td>味全龍</td><td>60</td><td>0</td><td>60</td><td>39</td><td>21</td><td>0</td><td>0.65</td><td>封王</td></tr></table>`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].record, "39-21-0");
    assert.equal(rows[0].gb, "封王");
  });

  it("parseZxcRows 下半季勝差取與第一名", () => {
    const rows = parseZxcRows(
      `<table><tr><td>名次</td><td>球隊</td><td>應賽</td><td>未賽</td><td>已賽</td><td>勝</td><td>敗</td><td>和</td><td>勝率</td><td>勝差(與前一名)</td><td>勝差(與第一名)</td></tr>
<tr><td>2</td><td>富邦悍將</td><td>38</td><td>0</td><td>38</td><td>16</td><td>22</td><td>0</td><td>0.421</td><td>0.5</td><td>4.5</td></tr></table>`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].gb, "4.5");
  });

  it("findTeam 別名", () => {
    assert.equal(findTeam("兄弟加油"), "中信兄弟");
    assert.equal(findTeam("統一獅"), "統一7-ELEVEn獅");
    assert.equal(findTeam("今天天氣"), undefined);
  });
});

describe("ybike helpers", () => {
  it("matchCity", () => {
    assert.equal(matchCity("高雄巨蛋", "Taipei"), "Kaohsiung");
    assert.equal(matchCity("台北車站", "Kaohsiung"), "Taipei");
    assert.equal(matchCity("", "Taipei"), "Taipei");
  });

  it("mergeAvailability 合併與暫停標記", () => {
    const rows = mergeAvailability(
      [{ StationUID: "A", StationID: "1", StationName: { Zh_tw: "測試站" }, StationAddress: { Zh_tw: "某路" }, BikesCapacity: 30 }],
      [{ StationUID: "A", StationID: "1", ServiceStatus: 0, AvailableRentBikes: 3, AvailableReturnBikes: 20, SrcUpdateTime: "2026-09-28T10:00:00" }],
    );
    assert.equal(rows[0].rent, 3);
    assert.equal(rows[0].paused, true);
  });
});

describe("metro helpers", () => {
  it("matchOperator", () => {
    assert.equal(matchOperator("高雄巨蛋", "TRTC"), "KRTC");
    assert.equal(matchOperator("西門", "TRTC"), "TRTC");
  });

  it("findStationId 精確優先", () => {
    const stations = [
      { StationID: "BL11", StationName: { Zh_tw: "台北車站" } },
      { StationID: "BL12", StationName: { Zh_tw: "西門" } },
    ];
    assert.equal(findStationId(stations, "西門")?.StationID, "BL12");
    assert.equal(findStationId(stations, "不存在"), undefined);
  });

  it("formatHeadway 候選鍵掃描", () => {
    const s = formatHeadway({ Direction: 0, PeakHeadway: "平均4分", OffPeakHeadway: "平均7分" });
    assert.ok(s.includes("去程") && s.includes("平均4分"));
  });
});
