import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "../src/config.js";
import { backfillRecentLogs, initLogger, logger } from "../src/logger.js";
import { nowIso } from "../src/time.js";

const savedLogFile = config.logFile;
const savedLogLimit = config.logLimit;
const savedLogLevel = config.logLevel;
const workDir = join(tmpdir(), `logbackfill-${process.pid}`);

after(() => {
  config.logFile = savedLogFile;
  config.logLimit = savedLogLimit;
  config.logLevel = savedLogLevel;
});

function useTmp(tag: string): string {
  const dir = join(workDir, tag);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "app.log");
  config.logFile = file;
  return file;
}

const today = nowIso().slice(0, 10);
const stamp = (hm: string): string => `${today}T${hm}:00+08:00`;

describe("logger 開機回填今日 log", () => {
  it("回填今日＋解析 meta（平台過濾可用）", () => {
    const file = useTmp("basic");
    config.logLimit = 200;
    writeFileSync(
      file,
      [
        `[${stamp("08:00")}] INFO 早安 {"platform":"line"}`,
        `[${stamp("09:00")}] WARN 抖動 {"platform":"telegram"}`,
        `[${stamp("10:00")}] ERROR 炸了 {"platform":"line","code":500}`,
      ].join("\n") + "\n",
      "utf8",
    );
    assert.equal(backfillRecentLogs(), 3);
    const recent = logger.getRecent();
    assert.equal(recent.length, 3);
    assert.equal(recent[0].message, "早安");
    assert.equal((recent[1].meta as Record<string, unknown>)?.platform, "telegram");
    assert.equal((recent[2].meta as Record<string, unknown>)?.code, 500);
    assert.equal(recent[2].level, "error");
  });

  it("昨日／垃圾行／低於 level 的行跳過", () => {
    const file = useTmp("filter");
    config.logLevel = "info";
    writeFileSync(
      file,
      [
        "這行根本不是 log",
        "[2020-01-01T00:00:00+08:00] INFO 去年今日",
        `[${stamp("11:00")}] DEBUG 太細不記`,
        `[${stamp("12:00")}] INFO 留下 {"a":1}`,
        `[${stamp("13:00")}] INFO 訊息尾巴有 JSON 也不誤拆 {"x":1} 後面還有字`,
      ].join("\n") + "\n",
      "utf8",
    );
    assert.equal(backfillRecentLogs(), 2);
    const recent = logger.getRecent();
    assert.equal(recent[0].message, "留下");
    // 尾段不是純 JSON 物件→整句留著當訊息（不拆 meta）
    assert.equal(recent[1].meta, undefined);
    assert.ok(recent[1].message.includes("後面還有字"));
  });

  it("超過 logLimit 只留最新的", () => {
    useTmp("cap");
    config.logLimit = 3;
    const lines = [];
    for (let i = 0; i < 5; i++) lines.push(`[${stamp(`14:0${i}`)}] INFO 第${i}則`);
    writeFileSync(join(workDir, "cap", "app.log"), lines.join("\n") + "\n", "utf8");
    assert.equal(backfillRecentLogs(), 3);
    assert.deepEqual(
      logger.getRecent().map((e) => e.message),
      ["第2則", "第3則", "第4則"],
    );
  });

  it(".1 輪替檔的今日段也讀（排在本檔之前）", () => {
    const file = useTmp("rot");
    config.logLimit = 200;
    writeFileSync(file, `[${stamp("15:00")}] INFO 本檔\n`, "utf8");
    writeFileSync(`${file}.1`, `[${stamp("14:00")}] INFO 前半段\n`, "utf8");
    assert.equal(backfillRecentLogs(), 2);
    assert.deepEqual(
      logger.getRecent().map((e) => e.message),
      ["前半段", "本檔"],
    );
  });

  it("檔案不存在不炸", () => {
    const file = useTmp("missing");
    assert.equal(backfillRecentLogs(), 0);
    assert.deepEqual(logger.getRecent(), []);
    void file;
  });

  it("initLogger 會回填（輪替先跑，不會把昨天讀回來）", () => {
    const file = useTmp("init");
    config.logLimit = 200;
    // 先建好今日日期檔，讓每日輪替跳過（否則 fixture 會被搬走）
    const utcDay = new Date().toISOString().slice(0, 10);
    writeFileSync(`${file}.${utcDay}`, "", "utf8");
    writeFileSync(file, `[${stamp("16:00")}] INFO 重啟前\n`, "utf8");
    initLogger();
    const recent = logger.getRecent();
    assert.ok(recent.some((e) => e.message === "重啟前"));
    assert.ok(recent.some((e) => e.message.includes("已回填今日 log")));
  });
});
