import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAirports } from "../src/skills/flight/index.js";

describe("機票出發地/目的地解析", () => {
  it("中文反向不反轉（東京飛台北）", () => {
    assert.deepEqual(resolveAirports("機票 東京飛台北 12月".toUpperCase()), ["NRT", "TPE"]);
  });

  it("中文正向（台北飛東京）", () => {
    assert.deepEqual(resolveAirports("機票 台北飛東京".toUpperCase()), ["TPE", "NRT"]);
  });

  it("IATA 代碼按文字順序（NRT TPE）", () => {
    assert.deepEqual(resolveAirports("機票 NRT TPE"), ["NRT", "TPE"]);
  });

  it("混合（中文在前、代碼在後）", () => {
    assert.deepEqual(resolveAirports("機票 東京 TPE".toUpperCase()), ["NRT", "TPE"]);
  });

  it("不足兩個回空陣列", () => {
    assert.deepEqual(resolveAirports("機票 東京".toUpperCase()), ["NRT"]);
    assert.deepEqual(resolveAirports("機票 幾月便宜"), []);
  });
});
