import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { alertSignature, formatWarnings, parseTyphoon, parseWarnings } from "../src/skills/typhoon/index.js";

describe("typhoon parseWarnings", () => {
  it("解析 location 形狀（每縣市一筆）", () => {
    const data = {
      records: {
        location: [
          {
            locationName: "高雄市",
            hazardConditions: {
              hazards: [
                {
                  hazard: {
                    info: {
                      phenomena: "RAIN",
                      significance: "WARNING",
                      startTime: "2026-07-01T21:30:00+08:00",
                      endTime: "2026-07-02T06:00:00+08:00",
                    },
                  },
                },
              ],
            },
          },
          {
            locationName: "屏東縣",
            hazardConditions: {
              hazards: [{ hazard: { info: { phenomena: "RAIN", significance: "WARNING" } } }],
            },
          },
        ],
      },
    };
    const ws = parseWarnings(data);
    assert.equal(ws.length, 2, "兩縣市的大雨特報各自一筆");
    assert.equal(ws[0].title, "大雨特報");
    assert.deepEqual(ws[0].areas, ["高雄市"]);
    assert.equal(ws[1].areas[0], "屏東縣");
  });

  it("解析 hazards 形狀（affectedAreas 內嵌）", () => {
    const data = {
      records: {
        hazards: [
          {
            hazard: {
              info: {
                phenomena: "WIND",
                significance: "WARNING",
                affectedAreas: { area: [{ description: "臺中市" }, { description: "彰化縣" }] },
              },
            },
          },
        ],
      },
    };
    const ws = parseWarnings(data);
    assert.equal(ws.length, 1);
    assert.equal(ws[0].title, "強風特報");
    assert.deepEqual(ws[0].areas, ["臺中市", "彰化縣"]);
  });

  it("空資料與怪結構都回空陣列", () => {
    assert.deepEqual(parseWarnings({}), []);
    assert.deepEqual(parseWarnings({ records: "nope" }), []);
    assert.deepEqual(parseWarnings({ records: { location: [{ locationName: "X" }] } }), []);
    assert.deepEqual(parseWarnings({ records: { hazards: [{ hazard: { info: {} } }] } }), []);
  });
});

describe("typhoon parseTyphoon", () => {
  it("取每颱風最新定位", () => {
    const tys = parseTyphoon({
      records: {
        TyphoonList: [
          {
            TyphoonName: "瑪丹娜",
            CwaTyNo: "202613",
            PathData: [
              {
                Time: "2026-08-01T08:00:00+08:00",
                Lat: "20.5",
                Lon: "125.0",
                MovingSpeed: "12",
                MovingDirection: "292",
                MaxWindSpeed: "43",
              },
              {
                Time: "2026-08-01T14:00:00+08:00",
                Lat: "21.2",
                Lon: "122.8",
                MovingSpeed: "15",
                MovingDirection: "300",
              },
            ],
          },
        ],
      },
    });
    assert.equal(tys.length, 1);
    assert.equal(tys[0].name, "瑪丹娜");
    assert.equal(tys[0].fixTime, "2026-08-01T14:00:00+08:00");
    assert.equal(tys[0].lat, 21.2);
    assert.equal(tys[0].lon, 122.8);
    assert.equal(tys[0].speed, 15);
    assert.equal(tys[0].direction, 300);
  });

  it("沒有 TyphoonList 或沒有名字就略過", () => {
    assert.deepEqual(parseTyphoon({}), []);
    assert.deepEqual(parseTyphoon({ records: { TyphoonList: [{ PathData: [] }] } }), []);
  });
});

describe("typhoon alertSignature / formatWarnings", () => {
  const warnings = parseWarnings({
    records: { hazards: [{ hazard: { info: { phenomena: "RAIN", significance: "WARNING" } } }] },
  });

  it("同樣內容簽章相同；時間欄位不影響", () => {
    const a = alertSignature(warnings, []);
    const b = alertSignature(
      parseWarnings({
        records: { hazards: [{ hazard: { info: { phenomena: "RAIN", significance: "WARNING" } } }] },
      }),
      [],
    );
    assert.equal(a, b);
    const empty = alertSignature([], []);
    assert.equal(empty, "##");
    assert.notEqual(a, empty);
  });

  it("颱風加入會改變簽章", () => {
    const tys = parseTyphoon({ records: { TyphoonList: [{ TyphoonName: "悟空", PathData: [] }] } });
    assert.notEqual(alertSignature(warnings, tys), alertSignature(warnings, []));
  });

  it("空清單回「無生效」", () => {
    assert.match(formatWarnings([], []), /目前無生效/);
  });

  it("有警報時列出標題與颱風定位", () => {
    const tys = parseTyphoon({
      records: {
        TyphoonList: [
          {
            TyphoonName: "悟空",
            CwaTyNo: "202601",
            PathData: [
              {
                Time: "2026-07-01T08:00:00+08:00",
                Lat: "20.5",
                Lon: "125.0",
                MovingSpeed: "12",
                MovingDirection: "292",
                MaxWindSpeed: "43",
              },
            ],
          },
        ],
      },
    });
    const text = formatWarnings(warnings, tys);
    assert.match(text, /目前警特報 1 筆/);
    assert.match(text, /大雨特報/);
    assert.match(text, /颱風「悟空」/);
    assert.match(text, /20\.5°N 125\.0°E/);
    assert.match(text, /向西北西/);
    assert.match(text, /人事行政總處/);
  });
});
