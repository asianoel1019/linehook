# 跨專案通知閘道（Integration Guide）

讓**其他專案**把事件推送到你的 LINE／Telegram／WhatsApp／Teams／Discord。
呼叫端不需要知道任何 IM 平台的細節：不用申請 token、不用處理訊息格式、不用管推播額度、不用重試。

```
外部專案（CI／監控／自動化）
        │  POST /hook/<名稱>   +簽章
        ▼
   本專案（閘道）── 驗簽 → 去重 → 降噪 → 套範本 → 投遞 → 記稽核
        │
        ▼
   LINE / Telegram / WhatsApp / Teams / Discord
```

---

## 1. 五分鐘接上

### 步驟一：建立一個 hook

管理頁呼叫（需 admin 權限的 session 或 `admin` scope 的 API Token）：

```bash
curl -X POST https://linehook.example.com/hooks \
  -H 'Authorization: Bearer <你的 admin API Token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "ci-failed",
    "description": "CI 失敗通知",
    "to": "工作群",
    "platform": "line",
    "template": "{{repo}} #{{pr}} ❌ {{reason}}",
    "include": ["failed"],
    "secret": "自己產生的一個長隨機字串"
  }'
```

| 欄位 | 說明 |
|---|---|
| `name` | hook 名稱（URL 片段；小寫字母、數字、`-`、`_`） |
| `to` | 目標對話：名稱或平台 id（名稱比較好維護） |
| `platform` | `line`（預設）／`telegram`／`whatsapp`／`teams`／`discord` |
| `template` | 訊息範本（見第 3 節）；不填則直接送 payload 的 `text` |
| `include` / `exclude` | 降噪關鍵字（見第 4 節） |
| `secret` | 這個 hook 專屬的簽章金鑰（強烈建議設定） |
| `replay` | 預設 `true`＝要 timestamp＋nonce（重放保護）；`false`＝只簽 body（不建議） |
| `async` | `true`＝立刻回 202、背景投遞（狀態可查） |
| `ratePerMin` | per-hook 速率上限（每分鐘幾次；預設 30，0＝不限） |
| `retries` | 投遞失敗時的重試次數（預設 2，指數退避） |
| `skill` | 觸發的技能 id（外部事件 → 跑技能 → 用技能輸出推播；見 5.4） |
| `skillArgs` | 傳給技能的參數範本（例：「{{city}} 天氣」） |
| `disabled` | `true` = 保留設定但暫停投遞 |

回應會把 `secret` 遮成 `****`（金鑰只在建立時看得到，之後也拿不回來——重設就重新建立）。

### 步驟二：讓你的專案打它

```bash
curl -X POST https://linehook.example.com/hook/ci-failed \
  -H 'Content-Type: application/json' \
  -H 'X-Hook-Signature: <見第 2 節的算法>' \
  -H 'Idempotency-Key: build-4213' \
  -d '{"repo":"proj/api","pr":4213,"reason":"3 tests failed"}'
```

回應：

```json
{ "ok": true, "hook": "ci-failed", "delivered": true, "platform": "line", "to": "工作群" }
```

---

## 2. 簽章（每個 hook 自己的金鑰）

三個標頭：

| 標頭 | 內容 |
|---|---|
| `X-Hook-Timestamp` | Unix 時間戳（**秒或毫秒皆可**，與本專案其他端點的 `X-Timestamp` 不同） |
| `X-Hook-Nonce` | 每次請求唯一（UUID、隨機字串…）；**不可重用** |
| `X-Hook-Signature` | `hex(HMAC-SHA256("{timestamp}.{nonce}.{原始 body}", secret))` |

```bash
BODY='{"repo":"proj/api","pr":4213}'
TS=$(date +%s)
NONCE=$(uuidgen)
SIG=$(printf '%s' "$TS.$NONCE.$BODY" | openssl dgst -sha256 -hmac '你的 secret' -hex | awk '{print $2}')

curl -X POST https://linehook.example.com/hook/ci-failed \
  -H "Content-Type: application/json" \
  -H "X-Hook-Timestamp: $TS" \
  -H "X-Hook-Nonce: $NONCE" \
  -H "X-Hook-Signature: $SIG" \
  -d "$BODY"
```

Node.js：

```js
import crypto from "node:crypto";
const ts = String(Math.floor(Date.now() / 1000));
const nonce = crypto.randomUUID();
const sig = crypto.createHmac("sha256", SECRET).update(`${ts}.${nonce}.${rawBody}`).digest("hex");
```

**三個規則**：

1. **簽的是原始 body 位元組**：不要先 `JSON.parse` 再重新序列化（空白與 key 順序會變，簽就不過）。
2. **hex 小寫**。
3. **nonce 不可重用**：同一個 nonce 再送一次會被視為重放（403）。重試請換新的 nonce 並重新簽名（冪等鍵保持不變）。

> 時間戳容許誤差為 `HMAC_MAX_SKEW_SEC`（預設 300 秒）。想用舊的簡單簽章（只簽 body、不要 timestamp/nonce），在 hook 設定裡加 `"replay": false`——但這樣就沒有重放保護，不建議。

沒設定 `secret` 的 hook 會走**全域** webhook 驗證（`HMAC_SECRET` / `X-Webhook-Token` / API Token），建議不要混用。

---

## 3. 範本語法

| 寫法 | 意思 |
|---|---|
| `{{repo}}` | 取 payload 的 `repo` |
| `{{build.obj.name}}` | 巢狀取值 |
| `{{msg | upper}}` | 濾鏡：`upper`／`lower`／`truncate:20`／`default:無` |
| `{{missing | default:（無）}}` | 取不到時給預設值 |

取不到的路徑 → 空字串（不會出現 `undefined`）。數字與物件會自動轉成文字。

範例：

```
{{repo}} #{{pr}} ❌ {{reason}}
{{build.status | upper}}：{{build.name}}
CI 完成：{{repo}}（{{duration | truncate:20}}）
```

---

## 4. 降噪（include / exclude）
比對的是 payload 的**所有 key 與 value**（不分大小寫）：

- `include: ["failed", "timeout"]` → 只有 payload 提到這些字才送。
- `exclude: ["draft", "wip"]` → 提到就不送（優先於 include）。

沒命中時閘道回 `{"ok":true,"skipped":true,"reason":"未命中任何包含詞"}`——**不投遞、但呼叫端收到 200**，所以 CI 不會因為「被跳過」而失敗。

---

## 5. 冪等與重試

外部專案常會重試（GitHub 尤其會）。兩種去重：

- `Idempotency-Key` 標頭（推薦）：同一個 key 在去重視窗內只投遞一次，第二次回 `{"ok":true,"duplicate":true}`。
- payload 的 `event_id` 欄位：沒有標頭時用它。

去重視窗長度由 `IDEMPOTENCY_WINDOW_MS` 決定（預設 10 分鐘）。

**重試時要換新的 nonce 並重新簽名**（冪等鍵保持不變）——沿用同一個 nonce 會被重放保護擋下（403），那是刻意的。

---

## 5.1 排程（延後投遞）

body 帶 `runAt`（ISO 字串／epoch／`YYYY-MM-DD HH:mm`）或 `sendAt`、`delaySec`：

```json
{ "repo": "proj/api", "what": "取貨", "runAt": "2026-11-03T18:30:00+08:00" }
```

會交給平台的排程器（**落盤**，重啟不丟），回應：

```json
{ "ok": true, "hook": "ci-failed", "scheduled": true, "id": "job-…", "runAt": "…", "repeat": null }
```

也可以帶 `repeat`（cron）做週期性推播。

---

## 5.2 非同步投遞與狀態查詢

hook 設定 `"async": true` 時，閘道**立刻回 202**、背景投遞（呼叫端不用等 IM API）：

```json
{ "ok": true, "hook": "ci-failed", "accepted": true, "deliveryId": "d-…", "platform": "line", "to": "工作群" }
```

查投遞結果：

```bash
curl https://linehook.example.com/hooks/ci-failed/deliveries -H 'Authorization: Bearer <token>'
```

```json
{ "hook": "ci-failed",
  "deliveries": [ { "id": "d-…", "at": 1762000000000, "status": "delivered", "ok": true,
                    "platform": "line", "target": "工作群", "finishedAt": 1762000000500 } ] }
```

`status` 有 `pending`（背景投遞中）／`delivered`／`failed`／`skipped`（被降噪規則跳過）／`scheduled`（已排程）。每個 hook 保留最近 20 筆。

---

## 5.3 per-hook 速率限制

預設每分鐘 30 次（`ratePerMin` 可調，0＝不限）。超過會回 **429**，訊息為「此 hook 超過速率上限（30 次／分鐘）」——壞掉的專案不會炸掉你的對話。

---

## 5.4 觸發技能（外部事件 → 技能 → 推播）

hook 可以指名一支技能：**不經觸發詞比對**（hook 已經指名了），技能收到的是渲染後的參數，它的回覆就是推播內容。

```json
{ "name": "deploy-report", "to": "工作群", "platform": "line",
  "skill": "weather", "skillArgs": "{{city}} 天氣", "secret": "…" }
```

事件 `{"city":"台北"}` → 技能收到 args「台北 天氣」→ 它的回覆被送到「工作群」。

- 技能必須是**已啟用**的（技能頁 → 啟用），否則回 502 並說明原因。
- 技能可以用 `ctx.reply`／`sendImage`／`schedule`；**不支援 `watch`**（hook 事件沒有對話任務脈絡，會明確報錯而不是靜默）。
- 技能輸出走平台的 `sendAdvanced`（佇列落盤、跨平台備援、死信都照常）。
- 技能執行也會被記錄（技能日誌的「最近執行」、耗時指標）。

---

## 5.5 失敗重試與連續失敗告警

- **重試**：投遞失敗（技能執行失敗也算）會依指數退避重試（1s、2s、4s…），次數由 `retries` 控制（預設 2）。
- **連續失敗告警**：同一個 hook 連續失敗 3 次 → 走既有的多通道告警（Email／webhook，見設定頁的告警設定）通知管理者；沒有設定告警通道時只寫 log。成功一次即歸零。

---

## 6. 管理 API

| 方法 | 路徑 | 權限 | 說明 |
|---|---|---|---|
| `GET` | `/hooks.json` | read | 列出 hooks（金鑰遮蔽，含最近投遞狀態） |
| `POST` | `/hooks` | admin | 新增或更新（同名覆蓋） |
| `DELETE` | `/hooks/:name` | admin | 刪除 |
| `GET` | `/hooks/:name/deliveries` | read | 該 hook 的投遞紀錄（含非同步 pending 狀態） |

---

## 7. 其他既有端點（低階用法）

不想設定 hook、想直接送訊息時：

```bash
curl -X POST https://linehook.example.com/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Signature: ...' -H 'X-Timestamp: ...' -H 'X-Nonce: ...' \
  -d '{"to":"工作群","text":"部署完成"}'
```

`/webhook` 支援 `runAt`（延後）、`repeat`（重複）、附件（`image`／`file`／`video`／`audio`）、多目標（`to` 陣列或 `messages`）。
平台也可以換：`/webhook/tg`、`/webhook/wa`、`/webhook/teams`、`/webhook/discord`。

**hook 與 `/webhook` 的差別**：hook 幫你記住「送到哪、寫成什麼、什麼時候不該送」；`/webhook` 每次都要自己說。

---

## 8. 觀察與除錯

- **稽核**：`/audit.json` 會記 `hook.deliver`／`hook.failed`／`hook.filtered`／`hooks.upsert`。
- **死信**：投遞失敗會進死信（`/deadletter.json`），可在 Console 一鍵重送。
- **指標**：`/metrics` 有 `hook_deliveries_total{hook,platform,result}` 與 `hook_auth_failures_total{hook}`。
- **最近狀態**：`GET /hooks.json` 裡每個 hook 的 `lastDelivery` 顯示上次投遞成功與否、時間、錯誤。
- **log**：`已投遞`／`hook 簽章驗證失敗` 等關鍵字。

---

## 9. 安全建議

1. **每個 hook 一把金鑰**：某家專案的金鑰外洩時只影響那個 hook，可單獨撤銷。
2. **不要把 admin API Token 給外部專案**：那是管理權限；只需要投遞請用 `send` scope 的 Token（給 `/webhook` 用），或直接用 hook 的簽章。
3. **hook 的 `to` 用名稱**：id 換了不改設定。
4. **開啟全域 webhook 驗證**：hook 沒設金鑰時會走全域驗證；全域驗證全關時，`/hook/:name` 會拒絕服務（503）而不是變成公開端點。

---

## 10. 場景範例

**CI/CD**

```json
{ "name": "ci-failed", "to": "工作群", "platform": "line",
  "template": "❌ {{repo}} #{{pr}}\n{{reason}}\n{{url}}",
  "include": ["failed"], "secret": "…" }
```

**監控告警**

```json
{ "name": "alert", "to": "Neal", "platform": "line",
  "template": "🚨 {{monitor}}：{{alertname}}\n{{value}}", "secret": "…" }
```

**家庭自動化**

```json
{ "name": "home", "to": "家人群", "platform": "line",
  "template": "{{device}}：{{state}}", "exclude": ["heartbeat"], "secret": "…" }
```

---

## 11. 延伸（規劃中）

- Webhook 介面（hook 觸發技能再推播的「二次轉送」鏈）
- 投遞失敗的自動重試已內建（指數退避）；進階：死信自動重送排程
- hook 的 UI 管理（目前用 API 管理）
