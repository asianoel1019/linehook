import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convertUnits } from "../src/skills/unit/index.js";

describe("convertUnits", () => {
  it("100 公分 = 1 公尺", () => {
    const r = convertUnits(100, "公分", "公尺");
    assert.equal(r.value, 1);
    assert.equal(r.from.name, "公分");
    assert.equal(r.to.name, "公尺");
  });

  it("5 台斤 = 3 公斤", () => {
    assert.equal(convertUnits(5, "台斤", "公斤").value, 3);
  });

  it("28°C = 82.4°F（浮點容忍）", () => {
    const v = convertUnits(28, "度C", "度F").value;
    assert.ok(Math.abs(v - 82.4) < 1e-9, `got ${v}`);
  });

  it("1 坪 ≈ 3.305785 平方公尺", () => {
    const v = convertUnits(1, "坪", "平方公尺").value;
    assert.ok(Math.abs(v - 3.305785) < 1e-9, `got ${v}`);
  });

  it("不同類別丟錯", () => {
    assert.throws(() => convertUnits(1, "公分", "公斤"), /不同類別/);
  });

  it("未知單位丟錯", () => {
    assert.throws(() => convertUnits(1, "光年", "公尺"), /未知單位/);
  });
});
