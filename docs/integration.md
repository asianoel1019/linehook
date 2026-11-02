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

`X-Hook-Signature` = `hex(HMAC-SHA256(原始請求 body, hook 的 secret))`。

```bash
BODY='{"repo":"proj/api","pr":4213}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac '你的 secret' -hex | awk '{print $2}')
```

Node.js：

```js
import crypto from "node:crypto";
const sig = crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");
```

- **原始 body**：簽的是送出時的位元組流，不要先 JSON.parse 再重新序列化（空白與 key 順序會變，簽就不過了）。
- **hex 小寫**（與 `safeEqual` 比對一致）。
- 沒設定 `secret` 的 hook 會走**全域** webhook 驗證（`HMAC_SECRET` / `X-Webhook-Token` / API Token），建議不要混用。

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

---

## 6. 管理 API

| 方法 | 路徑 | 權限 | 說明 |
|---|---|---|---|
| `GET` | `/hooks.json` | read | 列出 hooks（金鑰遮蔽，含最近投遞狀態） |
| `POST` | `/hooks` | admin | 新增或更新（同名覆蓋） |
| `DELETE` | `/hooks/:name` | admin | 刪除 |

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

- 非同步投遞（202 立刻回＋狀態查詢端點）
- per-hook 速率限制與熔斷
- per-hook 時間戳＋nonce 的重放保護
- 連續投遞失敗自動告警
- Webhook 介面（hook 觸發技能，例如「收到某事件就查天氣並推播」）
