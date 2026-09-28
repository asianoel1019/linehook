import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTtl } from "../src/skills/cache.js";

describe("parseTtl", () => {
  it("純數字視為分鐘", () => {
    assert.equal(parseTtl("60"), 60 * 60 * 1000);
  });

  it("m / h / s 後綴", () => {
    assert.equal(parseTtl("30m"), 30 * 60 * 1000);
    assert.equal(parseTtl("2h"), 2 * 3600 * 1000);
    assert.equal(parseTtl("90s"), 90 * 1000);
  });

  it("空白與大小寫容忍", () => {
    assert.equal(parseTtl(" 30M "), 30 * 60 * 1000);
  });

  it("無效輸入回 fallback", () => {
    assert.equal(parseTtl("abc", 60), 60 * 60 * 1000);
    assert.equal(parseTtl("60min", 60), 60 * 60 * 1000);
    assert.equal(parseTtl("", 5), 5 * 60 * 1000);
    assert.equal(parseTtl(undefined, 5), 5 * 60 * 1000);
    assert.equal(parseTtl("-3", 60), 60 * 60 * 1000);
  });
});
