import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  haversineMeters,
  geohashEncode,
  geohashBbox,
  geohashNeighbors,
  detectCities,
  formatDistance,
} from "../src/skills/geo.js";

describe("geo haversine/formatDistance", () => {
  it("台北車站→101 約 5 公里；同點為 0", () => {
    const d = haversineMeters(25.0478, 121.517, 25.0339, 121.5645);
    assert.ok(d > 4500 && d < 5500, `實得 ${d}`);
    assert.equal(haversineMeters(25, 121, 25, 121), 0);
    assert.equal(formatDistance(350), "約350公尺");
    assert.equal(formatDistance(1500), "約1.5公里");
  });
});

describe("geo geohash", () => {
  it("編碼長度與 cell 包含原點", () => {
    const h = geohashEncode(25.0478, 121.517, 6);
    assert.equal(h.length, 6);
    const b = geohashBbox(h);
    assert.ok(25.0478 >= b.latMin && 25.0478 <= b.latMax);
    assert.ok(121.517 >= b.lonMin && 121.517 <= b.lonMax);
  });

  it("鄰格 9 宮格互不重複且含中心", () => {
    const cells = geohashNeighbors(25.0478, 121.517, 6);
    assert.ok(cells.includes(geohashEncode(25.0478, 121.517, 6)));
    assert.ok(cells.length >= 4 && cells.length <= 9);
    assert.equal(new Set(cells).size, cells.length);
  });
});

describe("geo detectCities", () => {
  it("台北車站 → Taipei 優先", () => {
    const cities = detectCities(25.0478, 121.517);
    assert.equal(cities[0], "Taipei");
  });

  it("邊界重疊回多候選（龜山一帶）", () => {
    const cities = detectCities(24.99, 121.33);
    assert.ok(cities.includes("NewTaipei"));
    assert.ok(cities.includes("Taoyuan"));
  });

  it("外海無候選", () => {
    assert.deepEqual(detectCities(25.5, 123.5), []);
  });
});
