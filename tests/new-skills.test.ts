import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCoin, findCoinStrict, parseCryptoConversion, formatCryptoReply } from "../src/skills/crypto/index.js";
import { parseConversion, conversionArgs, toCode, findCurrencies } from "../src/skills/exchange-rate/index.js";
import { resolveSymbol, OTC_CODES } from "../src/skills/stock/index.js";
import { detectBrands, extractKeyword, filterDeals, formatDeals, type DealItem } from "../src/skills/deals/index.js";
import { toQuote } from "../src/skills/taiex/index.js";
import { fromUsgs, fromCwa, formatQuake } from "../src/skills/quake/index.js";
import { parseNum, computePercent, matchName, joinStatus } from "../src/skills/reservoir/index.js";
import { filterOutages, formatCase, parseNewsRss } from "../src/skills/outage/index.js";
import { parseTableItems, matchBudget } from "../src/skills/mcdonald/index.js";
import { parseOfficialRows, parseZxcRows, findTeam } from "../src/skills/cpbl/index.js";
import { mergeAvailability, matchCity } from "../src/skills/ybike/index.js";
import { matchOperator, findStationId, formatHeadway } from "../src/skills/metro/index.js";
import { resolveSymbol } from "../src/skills/stock/index.js";

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

describe("exchange-rate parseConversion（無前綴換算）", () => {
  it("雙幣別＋金額", () => {
    assert.deepEqual(parseConversion("100美金等於台幣"), { amount: 100, from: "USD", to: "TWD" });
    assert.deepEqual(parseConversion("1萬日幣換算台幣"), { amount: 10000, from: "JPY", to: "TWD" });
    assert.deepEqual(parseConversion("50 EUR 換成 USD"), { amount: 50, from: "EUR", to: "USD" });
  });

  it("雙幣別＋關鍵字（無金額預設 1）", () => {
    assert.deepEqual(parseConversion("日幣換算台幣多少"), { amount: 1, from: "JPY", to: "TWD" });
  });

  it("單幣別＋金額＋關鍵字走預設 TWD", () => {
    assert.deepEqual(parseConversion("100美金等於多少"), { amount: 100, from: "USD", to: "TWD" });
  });

  it("保守不觸發：閒聊不劫持", () => {
    assert.equal(parseConversion("我有100美金"), null);
    assert.equal(parseConversion("台幣美金"), null);
    assert.equal(parseConversion("今天天氣不錯"), null);
    assert.equal(parseConversion("100台幣等於多少"), null);
  });

  it("conversionArgs 可直接餵 run", () => {
    assert.equal(conversionArgs({ amount: 100, from: "USD", to: "TWD" }), "100 USD TWD");
  });

  it("toCode：國家＋單位", () => {
    assert.equal(toCode("越南幣"), "VND");
    assert.equal(toCode("越南盾"), "VND");
    assert.equal(toCode("越南"), "VND");
    assert.equal(toCode("美國"), "USD");
    assert.equal(toCode("法國"), "EUR");
    assert.equal(toCode("港幣"), "HKD");
    assert.equal(toCode("馬幣"), "MYR");
    assert.equal(toCode("韓幣"), "KRW");
    assert.equal(toCode("美元"), "USD");
    assert.equal(toCode("比特幣"), undefined);
    assert.equal(toCode("元"), undefined);
    assert.equal(toCode(""), undefined);
  });

  it("findCurrencies 依序掃描", () => {
    assert.deepEqual(findCurrencies("478美金是多少越南幣"), ["USD", "VND"]);
    assert.deepEqual(findCurrencies("匯率 1000 日幣 台幣"), ["JPY", "TWD"]);
    assert.deepEqual(findCurrencies("今天天氣不錯"), []);
  });

  it("parseConversion：國家名問法", () => {
    assert.deepEqual(parseConversion("478美金是多少越南幣"), { amount: 478, from: "USD", to: "VND" });
    assert.deepEqual(parseConversion("10000日圓等於幾塊台幣"), { amount: 10000, from: "JPY", to: "TWD" });
  });
});

describe("crypto 無前綴意圖與回覆", () => {
  it("findCoinStrict 不做預設", () => {
    assert.equal(findCoinStrict("比特幣")?.id, "bitcoin");
    assert.equal(findCoinStrict("ETH 多少")?.id, "ethereum");
    assert.equal(findCoinStrict("今天天氣不錯"), null);
  });

  it("parseCryptoConversion：金額＋關鍵字", () => {
    const r = parseCryptoConversion("0.5比特幣值多少");
    assert.equal(r?.coin.id, "bitcoin");
    assert.equal(r?.amount, 0.5);
    assert.equal(r?.target, "TWD");
    const u = parseCryptoConversion("2 eth 多少美金");
    assert.equal(u?.coin.id, "ethereum");
    assert.equal(u?.amount, 2);
    assert.equal(u?.target, "USD");
  });

  it("parseCryptoConversion：閒聊不劫持", () => {
    assert.equal(parseCryptoConversion("比特幣"), null);
    assert.equal(parseCryptoConversion("我買了比特幣"), null);
    assert.equal(parseCryptoConversion("今天天氣不錯"), null);
  });

  it("formatCryptoReply：有金額加總值，無金額維持原樣", () => {
    const p = { twd: 3600000, usd: 112500, twd_24h_change: 1.23, usd_24h_change: 1.2 };
    const withAmount = formatCryptoReply("比特幣", p, 0.5);
    assert.ok(withAmount.includes("0.5 顆 ≈ NT$ 1,800,000"));
    const plain = formatCryptoReply("比特幣", p, null);
    assert.ok(!plain.includes("顆 ≈"));
  });
});

describe("stock resolveSymbol（中文名）", () => {
  it("中文名、代號、美股、無效", () => {
    assert.equal(resolveSymbol("台積電"), "2330.TW");
    assert.equal(resolveSymbol("股價 台積電 現在"), "2330.TW");
    assert.equal(resolveSymbol("2330"), "2330.TW");
    assert.equal(resolveSymbol("股價 AAPL"), "AAPL");
    assert.equal(resolveSymbol("亂七八糟"), "");
  });
});

describe("deals helpers（優惠聚合）", () => {
  it("detectBrands：指名與泛稱", () => {
    assert.deepEqual(detectBrands("星巴克 買一送一"), ["星巴克"]);
    assert.deepEqual(detectBrands("優惠 漢堡"), ["麥當勞", "肯德基", "漢堡王", "摩斯漢堡"]);
    assert.equal(detectBrands("優惠"), null);
  });

  it("extractKeyword 去品牌字與金額", () => {
    assert.equal(extractKeyword("100 買一送一"), "買一送一");
    assert.equal(extractKeyword("肯德基 100"), "");
  });

  it("filterDeals：品牌＋價格帶＋關鍵字", () => {
    const items: DealItem[] = [
      { brand: "麥當勞", title: "大薯買一送一", detail: "$99", price: 99 },
      { brand: "肯德基", title: "咔啦雞腿堡餐", detail: "$129", price: 129 },
      { brand: "星巴克", title: "拿鐵買一送一", detail: "10/16" },
    ];
    assert.equal(filterDeals(items, { brands: ["麥當勞"], price: null, keyword: "" }).length, 1);
    assert.equal(filterDeals(items, { brands: null, price: 100, keyword: "" }).length, 2);
    assert.equal(filterDeals(items, { brands: null, price: null, keyword: "買一送一" }).length, 2);
    assert.deepEqual(filterDeals(items, { brands: null, price: null, keyword: "沒有這種東西" }), []);
  });

  it("formatDeals 形狀", () => {
    const s = formatDeals("今日優惠速覽：", [{ brand: "麥當勞", title: "大薯", detail: "$99" }], "hint");
    assert.ok(s.includes("【麥當勞】大薯"));
    assert.ok(s.endsWith("hint"));
  });
});

describe("stock resolveSymbol（公司名＋上櫃）", () => {
  it("代號與中文名", () => {
    assert.equal(resolveSymbol("股價 2330"), "2330.TW");
    assert.equal(resolveSymbol("股價 台積電"), "2330.TW");
    assert.equal(resolveSymbol("臺積電現在多少"), "2330.TW");
    assert.equal(resolveSymbol("群聯"), "8299.TWO");
    assert.equal(resolveSymbol("全家"), "5903.TWO");
    assert.equal(resolveSymbol("中華汽車"), "2204.TW");
    assert.equal(resolveSymbol("台積電法說會"), "2330.TW");
  });

  it("直接打上櫃代號走 .TWO", () => {
    assert.equal(resolveSymbol("股價 5483"), "5483.TWO");
    assert.equal(resolveSymbol("股價 2330"), "2330.TW");
    assert.ok(OTC_CODES.has("8299"));
    assert.ok(!OTC_CODES.has("2330"));
  });

  it("子字串後援與未知回空", () => {
    assert.equal(resolveSymbol("我想問台積電"), "2330.TW");
    assert.equal(resolveSymbol("亂七八糟"), "");
  });
});
