// 跨平台測試啟動器：設定儲存層預設後，交給 node --test 跑（glob 由 node 展開）。
// 生產預設 STORAGE_KIND=sqlite；測試預設 jsonl（斷言檔案內容的測試才能穩定）。
// 可用環境變數覆寫：set STORAGE_KIND=sqlite & node tests/run.mjs（或 POSIX STORAGE_KIND=sqlite node ...）
import { spawnSync } from "node:child_process";

const env = { ...process.env };
env.STORAGE_KIND = process.env.STORAGE_KIND || "jsonl";

const args = process.argv.slice(2);
const files = args.length > 0 ? args : ["tests/*.test.ts"];

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  env,
});
process.exit(result.status ?? 1);
