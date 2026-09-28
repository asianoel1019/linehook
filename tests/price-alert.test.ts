import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAlertCommand, isHit } from "../src/skills/price-alert/index.js";

describe("parseAlertCommand", () => {
  it("清單", () => {
    assert.deepEqual(parseAlertCommand("清單"), { op: "list" });
    assert.deepEqual(parseAlertCommand("list"), { op: "list" });
  });

  it("取消（編號與關鍵字）", () => {
    assert.deepEqual(parseAlertCommand("取消 1"), { op: "cancel", key: "1" });
    assert.deepEqual(parseAlertCommand("取消 2330"), { op: "cancel", key: "2330" });
    assert.deepEqual(parseAlertCommand("取消"), { op: "help" });
  });

  it("股價高於", () => {
    assert.deepEqual(parseAlertCommand("股價 2330 高於 2500"), {
      op: "add-stock",
      symbol: "2330.TW",
      dir: "above",
      price: 2500,
    });
  });

  it("符號方向（> 與 <）", () => {
    const up = parseAlertCommand("2330 > 2500");
    assert.equal(up.op, "add-stock");
    if (up.op === "add-stock") {
      assert.equal(up.symbol, "2330.TW");
      assert.equal(up.dir, "above");
      assert.equal(up.price, 2500);
    }
    const down = parseAlertCommand("2330 < 2000");
    assert.equal(down.op, "add-stock");
    if (down.op === "add-stock") assert.equal(down.dir, "below");
  });

  it("無方向回 infer（目標取最後一個數字）", () => {
    const cmd = parseAlertCommand("2330 2500");
    assert.equal(cmd.op, "add-stock");
    if (cmd.op === "add-stock") {
      assert.equal(cmd.dir, "infer");
      assert.equal(cmd.price, 2500);
    }
  });

  it("美股代號", () => {
    const cmd = parseAlertCommand("AAPL 高於 200");
    assert.equal(cmd.op, "add-stock");
    if (cmd.op === "add-stock") assert.equal(cmd.symbol, "AAPL");
  });

  it("匯率雙幣別", () => {
    const cmd = parseAlertCommand("匯率 美金 台幣 低於 29.5");
    assert.deepEqual(cmd, { op: "add-fx", base: "USD", target: "TWD", dir: "below", price: 29.5 });
  });

  it("匯率代碼相連（美金到台幣）", () => {
    const cmd = parseAlertCommand("匯率 美金到台幣 高於 33");
    assert.equal(cmd.op, "add-fx");
    if (cmd.op === "add-fx") {
      assert.equal(cmd.base, "USD");
      assert.equal(cmd.target, "TWD");
    }
  });

  it("資訊不足回 help", () => {
    assert.deepEqual(parseAlertCommand(""), { op: "help" });
    assert.deepEqual(parseAlertCommand("股價"), { op: "help" });
    assert.deepEqual(parseAlertCommand("匯率 美金"), { op: "help" });
    assert.deepEqual(parseAlertCommand("亂七八糟"), { op: "help" });
  });
});

describe("isHit", () => {
  it("高於：現價 >= 目標觸發（含等於）", () => {
    assert.equal(isHit("above", 2500, 2500), true);
    assert.equal(isHit("above", 2501, 2500), true);
    assert.equal(isHit("above", 2499, 2500), false);
  });

  it("低於：現價 <= 目標觸發（含等於）", () => {
    assert.equal(isHit("below", 29.5, 29.5), true);
    assert.equal(isHit("below", 29.4, 29.5), true);
    assert.equal(isHit("below", 29.6, 29.5), false);
  });
});
