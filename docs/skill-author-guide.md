# 技能作者教學：從零寫到能上架

這份文件教你寫一支 ImHook 技能：怎麼註冊、能用什麼、怎麼測試、怎麼打包成 zip 分享給別人。

一支技能就是一個資料夾 `src/skills/<id>/`，裡面至少有一個 `index.ts`（或 `index.js`）。

---

## 1. 最小可用的技能

```ts
// src/skills/hello/index.ts
import type { SkillContext, SkillDefinition } from "@lw/skills/types";

const helloSkill: SkillDefinition = {
  id: "hello",                       // 唯一 id（英文、小寫）
  name: "哈囉",
  description: { zh: "打招呼", en: "Say hello" },
  usage: { zh: "hello 名字" },        // 會顯示在「用法」查詢
  category: { zh: "工具", en: "Tools" },
  defaultTrigger: "哈囉",             // 使用者打「阿寶請幫忙 哈囉 世界」就會進來
  triggerAliases: ["hi", "哈囉你好"],  // 別名（可省略）
  fields: [],                        // 設定頁欄位（可省略）
  async run(ctx: SkillContext): Promise<void> {
    await ctx.reply(`哈囉 ${ctx.args || "世界"}！`);
  },
};

export default helloSkill;
```

`@lw/skills/types` 這個別名指向主機的 `src/skills/types.ts`，技能與主機共用同一份型別定義。

### 觸發方式

| `triggerMode` | 行為 |
|---|---|
| `"assistant"`（預設） | 只有「阿寶請幫忙 <觸發詞> ...」才會進來 |
| `"any"` | 每則訊息都會進來（自己判斷要不要回，例如關鍵字自動回覆） |

`"any"` 模式請務必先讀 `ctx.args` 判斷內容，否則每則訊息都會回覆。

---

## 2. ctx 能做什麼

```ts
async run(ctx: SkillContext): Promise<void> {
  ctx.text;            // 觸發詞之後的原文（等於 args）
  ctx.args;            // 同上
  ctx.chat;            // 對話 id（群組就是群組 id）
  ctx.fromMid;         // 寄件者 id
  ctx.fromName;        // 寄件者名稱
  ctx.config;          // 使用者在設定頁填的值（字串）
  ctx.images;          // 附件圖片（base64），可餵給 AI 視覺
  ctx.location;        // 使用者傳的位置（附近查詢類用）

  await ctx.reply("文字回覆");
  await ctx.sendImage("https://.../a.png", "a.png");
  await ctx.sendFile("/tmp/report.pdf", "report.pdf");
  const jobId = ctx.schedule("五分鐘後提醒你", Date.now() + 5 * 60_000);
  const taskId = ctx.watch({ task: "daily", at: "08:00", args: { text: "喝水" } });
  ctx.unwatch(taskId);
  ctx.watches();                        // 目前這個對話的 watch 清單
  ctx.taskState(taskId);                // 上次存下的 state（只有 run() 的 ctx 有；onTask 用 ctx.state）
```

### 週期任務（watch）

```ts
ctx.watch({
  task: "eta",                          // 任務名（同一對話同名會取代）
  at: "08:00",                          // 每天固定時間
  // cron: "0 8 * * *",                 // 或標準 5 欄 cron
  // everyMinutes: 30,                 // 或每 N 分鐘（1–1440，超過 60 需為 60 的倍數）
  args: { route: "307" },               // 會持久化，onTask 拿得到
  state: { lastKey: "" },               // 初始 state（可持久化）
});
```

技能要處理週期任務，就實作 `onTask`：

```ts
async onTask(ctx: SkillTaskContext): Promise<void> {
  const st = ctx.state as { lastKey?: string };   // onTask 讀的是 ctx.state（不是 taskState）
  const key = computeKey();
  if (key === st.lastKey) return;                  // 避免重複推播
  await ctx.reply("公車快到了");
  await ctx.saveState({ lastKey: key });            // 持久化（下次 onTask 的 ctx.state 就有）
}
```

`onTask` 裡的 `ctx` 沒有 `reply` 以外的 `text`；要取文字用 `ctx.args`（就是當初 `watch({ args })` 存的）。

---

## 3. 設定頁欄位（fields）

```ts
fields: [
  { key: "apiKey", label: { zh: "API Key" }, secret: true },
  { key: "city", label: { zh: "預設城市" }, default: "台北" },
  {
    key: "mode",
    label: { zh: "模式" },
    type: "select",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
  },
  { key: "interval", label: { zh: "間隔（分）" }, type: "number", min: 1, max: 1440 },
],
```

- `secret: true` → 設定頁用密碼框，且不會出現在明文輸出。
- `pattern` / `min` / `max` / `required` → 儲存時會擋下不合法值。

---

## 4. 權限宣告（P2）

`skill.json` 可以宣告這支技能要做什麼事，安裝時會顯示、稽核會記錄：

```json
{
  "id": "my-skill",
  "name": "我的技能",
  "version": "1.0.0",
  "api": 1,
  "permissions": {
    "network": ["api.example.com"],
    "files": "temp",
    "readOtherSkills": false
  }
}
```

- `network`：會連到的網域（主機名，不含 https://）。
- `files`：`"none"`（不寫檔）／`"temp"`（暫存目錄）／`"data"`（含 data/ 與設定）。
- `readOtherSkills`／`callOtherSkills`：會讀其他技能／呼叫其他技能。

宣告跟實際行為不一致時，管理頁的「技能網域報告」會標紅（連到沒宣告的網域）。

---

## 5. 測試（用輔助套件）

主機提供 `createSkillHarness()`，5 行就能測：

```ts
// tests/my-skill.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSkillHarness } from "../src/skills/test-kit.js";
import mySkill from "../src/skills/my-skill/index.js";

describe("my-skill", () => {
  it("會回覆哈囉", async () => {
    const h = createSkillHarness({ config: { city: "台北" } });
    await h.run(mySkill, "世界");
    assert.deepEqual(h.replies, ["哈囉 世界！"]);
  });

  it("會註冊 watch", async () => {
    const h = createSkillHarness();
    await h.run(mySkill, "每天 08:00 喝水");
    assert.equal(h.watched.length, 1);
    assert.equal(h.watched[0].task, "daily");
  });
});
```

harness 收集到：`h.replies`（回覆）、`h.media`（圖片/檔案）、`h.schedules`（一次性排程）、`h.watched`（週期任務）、`h.state`（持久化 state）。

跑測試：

```bash
node tests/run.mjs tests/my-skill.test.ts
```

---

## 6. 打包成 zip 分享

內建技能可以用既有腳本打包（產出 `library/<id>.zip`）：

```bash
npm run build          # 先編譯（zip 帶 dist 版）
node scripts/build-library.mjs
```

自己打包也行——zip 結構二擇一：

- zip 內含單一資料夾：`my-skill/index.js` + `my-skill/skill.json`
- zip 根目錄就是技能檔：`index.js` + `skill.json`

`skill.json` 至少要有 `id`（與資料夾名一致）、`name`、`version`、`api`（相容版本，見 `SKILL_API_VERSION`）。

對方在「技能 → 安裝/移除」上傳 zip 就裝好了；安裝前系統會自動備份舊版，裝壞了可以回滾。

---

## 7. 建議的開發流程

```bash
npm run typecheck   # 型別
npm run lint        # 程式風格
npm test            # 全部測試（單檔：node tests/run.mjs tests/xxx.test.ts）
npm run build       # 產 dist
```

改完技能**不用重啟服務**：主機有熱重載（監看技能目錄，改檔自動重載，log 會出現「技能已熱重載」）。

---

## 8. 可用的別名（@lw/*）

| 別名 | 用途 |
|---|---|
| `@lw/logger` | 寫日誌（`logger.info/warn/error`） |
| `@lw/config` | 目前設定（`config.skills`、`config.timezone`…） |
| `@lw/net` | 對外請求（`fetchJson`／`fetchText`／`fetchBuffer`，有逾時、大小上限、SSRF 防護、網域管制） |
| `@lw/time` | 時區換算（`nowInTz`、`zonedTimeToMs`、`formatInTz`） |
| `@lw/skills/types` | 技能型別（`SkillDefinition`、`SkillContext`…） |
| `@lw/skills/cache` | 快取（`readCache`／`writeCache`／`parseTtl`） |
| `@lw/skills/geo` | 地理計算（`haversineMeters`、`detectCities`、`geohashNeighbors`） |
| `@lw/skills/llm` | 呼叫 LLM（`chat`、`llmConfigFrom`） |
| `@lw/skills/agent` | 多輪工具型 agent（`runAgent`） |

別名由主機的 `alias.mjs` 提供，技能 zip 只帶 `index.js` 也能在任何有主機的環境跑（自包含）。
