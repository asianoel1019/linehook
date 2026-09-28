import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { watchOptionsToCron, everyMinutesToCron, dailyAtToCron, describeWatch } from "../src/skills/watch.js";

describe("everyMinutesToCron", () => {
  it("30 分鐘", () => {
    assert.equal(everyMinutesToCron(30), "*/30 * * * *");
  });

  it("60 分鐘為整點", () => {
    assert.equal(everyMinutesToCron(60), "0 * * * *");
  });

  it("120 分鐘", () => {
    assert.equal(everyMinutesToCron(120), "0 */2 * * *");
  });

  it("1440 為每天午夜", () => {
    assert.equal(everyMinutesToCron(1440), "0 0 * * *");
  });

  it("非法值丟錯", () => {
    assert.throws(() => everyMinutesToCron(0), /1–1440/);
    assert.throws(() => everyMinutesToCron(90), /60 的倍數/);
    assert.throws(() => everyMinutesToCron(1.5), /1–1440/);
  });
});

describe("dailyAtToCron", () => {
  it("08:00", () => {
    assert.equal(dailyAtToCron("08:00"), "0 8 * * *");
  });

  it("容忍單位數與全形冒號", () => {
    assert.equal(dailyAtToCron("8:05"), "5 8 * * *");
    assert.equal(dailyAtToCron("23：59"), "59 23 * * *");
  });

  it("非法時間丟錯", () => {
    assert.throws(() => dailyAtToCron("24:00"), /HH:mm/);
    assert.throws(() => dailyAtToCron("早上八點"), /HH:mm/);
  });
});

describe("watchOptionsToCron", () => {
  it("cron 直通（並驗證）", () => {
    assert.equal(watchOptionsToCron({ task: "x", cron: "0 8 * * *" }), "0 8 * * *");
    assert.throws(() => watchOptionsToCron({ task: "x", cron: "nope" }), /5 欄/);
  });

  it("at / everyMinutes 轉換", () => {
    assert.equal(watchOptionsToCron({ task: "x", at: "07:30" }), "30 7 * * *");
    assert.equal(watchOptionsToCron({ task: "x", everyMinutes: 15 }), "*/15 * * * *");
  });

  it("都不給預設 30 分鐘", () => {
    assert.equal(watchOptionsToCron({ task: "x" }), "*/30 * * * *");
  });

  it("三選一與空任務名丟錯", () => {
    assert.throws(() => watchOptionsToCron({ task: "x", cron: "0 8 * * *", at: "08:00" }), /擇一/);
    assert.throws(() => watchOptionsToCron({ task: "  " }), /任務名稱/);
  });
});

describe("describeWatch", () => {
  it("人類可讀描述", () => {
    assert.equal(describeWatch({ task: "x", at: "08:00" }), "每天 08:00");
    assert.equal(describeWatch({ task: "x", everyMinutes: 30 }), "每 30 分鐘");
    assert.equal(describeWatch({ task: "x", everyMinutes: 120 }), "每 2 小時");
    assert.equal(describeWatch({ task: "x" }), "每 30 分鐘");
  });
});
