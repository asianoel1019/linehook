#!/usr/bin/env node
// coverage-gate.mjs — 跑測試覆蓋率，低於門檻就失敗（防「新功能沒測試」型退化）。
// 用法：node scripts/coverage-gate.mjs [files...]
// 門檻：COVERAGE_MIN_LINES（預設 35；撰寫時全量約 43%）
import { spawnSync } from "node:child_process";

const min = Number(process.env.COVERAGE_MIN_LINES) > 0 ? Number(process.env.COVERAGE_MIN_LINES) : 35;
const files = process.argv.slice(2);
const alias = new URL("../alias.mjs", import.meta.url).href;

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--import",
    alias,
    "--test",
    "--experimental-test-coverage",
    ...(files.length > 0 ? files : ["tests/*.test.ts"]),
  ],
  { stdio: "pipe" },
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
if (result.status !== 0) {
  // 測試本身就失敗：原樣輸出讓 CI 看得到，不需要再判覆蓋率
  process.stdout.write(output);
  console.error("測試失敗（覆蓋率未評估）");
  process.exit(1);
}

const match = output.match(/all files\s*\|\s*([\d.]+)\s*\|/);
const pct = match ? Number(match[1]) : null;
if (pct === null) {
  console.error("找不到覆蓋率摘要（all files）— 請確認 node --test 的輸出格式");
  process.exit(1);
}

console.log(`行覆蓋率：${pct}%（門檻 ${min}%）`);
if (pct < min) {
  console.error(`覆蓋率低於門檻：${pct}% < ${min}%（可用 COVERAGE_MIN_LINES 調整）`);
  process.exit(1);
}
process.exit(0);
