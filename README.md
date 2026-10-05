# IM Webhook

接收外部端點傳來的訊息，轉發到多個通訊軟體（目前支援 LINE、Telegram、WhatsApp、Teams，架構可擴充）。
LINE 透過已登入的個人帳號（selfbot），Telegram 走 Bot API，WhatsApp 可選官方 Cloud API 或個人帳號（WhatsApp Web），Teams 走企業 Bot（Entra + Bot Connector）。
附登入狀態頁（可互動）、Email 通知，登入失效時會自動嘗試重登。

> ⚠️ 本專案使用非官方 LINE API（[`@evex/linejs`](https://github.com/evex/linejs)）模擬個人帳號，屬 selfbot，
> **違反 LINE 服務條款，帳號有被停權的風險**。請自行評估，建議使用備用帳號。

## 功能

- Webhook 接收 `{ to, text }` 並轉發到指定好友 / 群組；支援**多訊息類型**（`text` / `file` / `image` / `sticker` / `location` / `flex`）、**訊息模板 + 變數**（`template` / `vars`）、**排程 / 延遲發送**（`sendAt` / `delaySec`）與**多收件人**（`to` 陣列）
- **多 IM**：LINE、Telegram、WhatsApp（Cloud API／個人帳號雙模式）、Teams，各有獨立發送端點（`POST /webhook`、`/webhook/tg`、`/webhook/wa`、`/webhook/teams`）與接收機制；共用驗證、技能、排程框架
- **右上角全域 IM 切換**：所有管理頁共用同一個平台切換（LINE／Telegram／WhatsApp／Teams，附各平台 icon），切換後各頁只顯示該平台內容並記住選擇
- **發送佇列**：序列化發送、最小間隔節流、失敗自動退避重試
- 來源 IP 白名單 + HMAC-SHA256 簽章（含 timestamp / nonce 防重放）+ 速率限制 + **idempotency 去重**（`X-Idempotency-Key`）
- **管理頁面一律需登入**（`/dashboard`、`/console`、`/skills`、`/settings`、`/messages`、`/readme`），閒置 5 分鐘自動登出並導回登入頁；側欄底部為使用者圓形按鈕（顯示帳號首字，上方顯示**閒置登出倒數**），點擊可**登出**或**變更密碼**；側欄可切換**語言（中文 / English / 日本語）**
- **儀表板 `/dashboard`**（登入後首頁）：依右上角選擇的平台顯示該平台的狀態摘要與發送統計（總數 / 成功 / 失敗 / 成功率、近 N 日長條圖、類型分佈）；停用的平台顯示「未啟用」空白狀態。另有最近紀錄、登入 QR（LINE／WhatsApp 個人帳號模式依平台顯示不同掃描說明）
- **功能頁 `/console`**：左側「功能」卡片（依平台過濾的測試發送含媒體上傳、目標清單、最近紀錄、排程中的訊息可改變時間 / 取消）與「操作」（LINE 重新登入 / 重新整理聯絡人，僅 LINE 可見；Flex 可視化編輯僅 LINE）
- **技能頁 `/skills`**：啟用助理與名稱、每個技能（資料夾）一張卡片可 enable/disable 與設定參數；技能為可下載子專案（見下方「可下載技能」）
- **設定頁 `/settings`**：左側設定卡片，**線上編輯設定**（存於 `settings.json`，立即生效）；共用設定永遠可見，平台專屬（LINE 登入／目標對照、Telegram Bot、WhatsApp、Teams）只在切到該平台時顯示
- **訊息頁 `/messages`**：記錄收到的訊息（唯讀瀏覽；可選持久化到檔案）
- **關鍵字自動回覆**：收到訊息且內容與關鍵字「完全相符」時，自動回覆文字與／或檔案，含**每聊天冷卻**（於 `/settings` 設定）
- 登入失效自動重登；失敗時寄 Email 通知
- **log 輪替**（依大小）
- 啟動時驗證 `.env`（zod），缺必填直接報錯
- Graceful shutdown（SIGINT / SIGTERM）

## 環境需求

- Node.js 20+（開發用 24）
- 一支 LINE 帳號與可收驗證的手機

## 安裝

```sh
npm install
Copy-Item .env.example .env   # Windows
# cp .env.example .env        # macOS / Linux
```

編輯 `.env`（見下方設定說明），然後：

```sh
npm run dev      # 開發（tsx watch）
npm run build    # 編譯到 dist/
npm start        # 執行編譯後版本
npm run typecheck
```

首次啟動時沒有 `authToken`，終端機會直接印出可掃描的 QR Code，狀態頁也會顯示 QR 圖；
用手機 LINE 的掃描功能掃描即可完成登入（或點狀態頁的「驗證連結」在手機開啟）。
之後 token 會存到 `storage.json` 自動登入。
裝置名稱（`LINE_DEVICE_NAME`）只在登入時送出，修改後需刪除 `storage.json` 重新登入才會生效。

## 設定

設定分兩層：

- **`.env`（bootstrap，無法在網頁修改）**：`PORT`、`SETTINGS_PATH`、`STORAGE_PATH`、`LOG_FILE`、`MESSAGES_PATH`、`STATUS_USER`、`STATUS_PASS`
- **`/settings` 頁面（存於 `settings.json`，修改後立即生效）**：其餘所有項目
- 優先順序：`.env` < `settings.json`（`.env` 可作為初始預設值）

> `settings.json` 是執行期資料庫（助理 / 技能 / 目標對照 / 密鑰都在裡面），部署時務必保留、勿覆蓋，詳見下方「部署」章節。

### `.env`（bootstrap）

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PORT` | `8090` | 服務埠 |
| `SETTINGS_PATH` | `./settings.json` | 執行期設定儲存檔 |
| `STORAGE_PATH` | `./storage.json` | 登入 token 儲存位置 |
| `LOG_FILE` | `./logs/app.log` | log 檔路徑 |
| `MESSAGES_PATH` | `./data/messages.jsonl` | 收到的訊息持久化檔（JSONL）；是否寫入由 `/settings` 開關控制 |
| `SCHEDULES_PATH` | `./data/schedules.json` | 排程訊息持久化檔；重啟後恢復未到期排程 |
| `STATS_PATH` | `./data/stats.jsonl` | 發送統計（JSONL，供儀表板） |
| `STATS_DAYS` | `14` | 儀表板統計顯示天數 |
| `UPLOADS_PATH` | `./data/uploads` | 網頁上傳檔案儲存目錄 |
| `MAX_BODY_MB` | `25` | 請求 body 大小上限（MB） |
| `STATUS_USER` / `STATUS_PASS` | 空 | 設定頁登入帳密（一律需要登入；留空會自動產生臨時密碼並顯示於 console） |
| `AUTH_PATH` | `./data/auth.json` | 於網頁「變更密碼」後，新密碼（scrypt 雜湊）儲存位置；存在時覆蓋 `STATUS_USER` / `STATUS_PASS` |
| `LANGUAGE` | `zh` | 介面語言初始值（`zh` / `en` / `ja`）；之後可在側欄切換，存於 `settings.json` |
| `TIMEZONE` | `Asia/Taipei` | IANA 時區；影響 log 時間與技能（如「今天」判斷），可在 `/settings` 修改 |

### `/settings` 可線上修改

`ALLOWED_IPS`、`HMAC_SECRET`、`HMAC_MAX_SKEW_SEC`、`WEBHOOK_TOKEN`、`API_TOKEN`、`ADMIN_PRIVATE_ONLY`、
`RATE_LIMIT_WINDOW_MS`、`RATE_LIMIT_MAX`、
`LINE_DEVICE`、`LINE_DEVICE_NAME`、`LINE_MODEL_NAME`、
`SEND_MAX_RETRIES`、`SEND_RETRY_BASE_MS`、`SEND_MIN_INTERVAL_MS`、
`HEALTH_CHECK_INTERVAL_SEC`、`LOG_LIMIT`、`LOG_MAX_BYTES`、`LOG_MAX_FILES`、`TARGETS`、訊息模板、
訊息持久化開關、自動回覆（含冷卻秒數）、`SMTP_*`、`MAIL_FROM`、`MAIL_TO`、
Telegram（`TELEGRAM_*`）、WhatsApp（`WHATSAPP_*`，含 Cloud／個人帳號模式切換）、Teams（`TEAMS_*`）。

> `LINE_DEVICE_NAME` / `LINE_DEVICE` 需重新登入（刪除 `storage.json`）才會反映在 LINE 顯示的裝置名稱。
> `.env.example` 仍保留這些項目的預設值，可作為啟動初始值。

### 只讓 webhook 對外、管理頁面限內網

想要「`/webhook` 公開給外部服務打、但 `/dashboard` `/console` `/settings` `/messages` `/readme` 只能內網開」時：

- `ALLOWED_IPS` 留空（webhook 不限制來源）
- 勾選 `/settings` 的「僅限私人 IP 存取管理頁面」（或 `.env` 設 `ADMIN_PRIVATE_ONLY=true`）

如此管理頁面只允許私人位址（`10.x`、`172.16–31.x`、`192.168.x`、`127.x`、IPv6 `::1` / `fc00::/7` / `fe80::/10`）存取；webhook 不受影響。
判定用的是「有效客戶端 IP」（經 nginx 時為 `X-Forwarded-For` 最左側，也就是真實來源）。

## API

各 IM 發送端點語意相同（body 格式見下方），僅路徑與目標對照不同：

| 平台 | 發送 | 接收 | 目標對照 |
| --- | --- | --- | --- |
| LINE | `POST /webhook` | 長連線（無 webhook） | 名稱=mid |
| Telegram | `POST /webhook/tg` | `POST /tg/update`（驗 secret token） | 名稱=chat_id（或 @username） |
| WhatsApp | `POST /webhook/wa` | Cloud 模式：`GET/POST /wa/webhook`（驗簽章）；個人帳號模式：長連線，無 webhook | 名稱=電話號碼（E.164 不含 +） |
| Teams | `POST /webhook/teams` | `POST /teams/messages`（驗 Bearer JWT） | 名稱=conversation id（收訊後自動記住） |

發送端點共用驗證（HMAC／URL Token／API Token）；未啟用的平台回 `503`。

### `POST /webhook`（以 LINE 為例，其他平台同格式）

```http
POST /webhook HTTP/1.1
Content-Type: application/json
X-Timestamp: <毫秒 epoch>
X-Signature: <hex>
X-Nonce: <可選，唯一字串>
X-Idempotency-Key: <可選，唯一字串；同 key 只會發送一次>

{
  "to": "好友名稱或 mid",           // 或陣列：["小明","測試群"]
  "text": "要轉發的訊息",            // 可選
  "file": "/path/on/server/quote.pdf",  // 可選，伺服器上的檔案路徑
  "image": "https://example.com/a.jpg", // 可選，URL 或伺服器路徑
  "video": "https://example.com/a.mp4", // 可選，影片（URL / 路徑 / data URL）
  "audio": "https://example.com/a.m4a", // 可選，語音
  "filename": "報價單.pdf",          // 可選，顯示檔名

  "template": "每日報價",            // 可選，套用 /settings 定義的模板（text 未給時採用模板內容）
  "vars": { "name": "小明", "amount": "100" },  // 可選，模板 / text 內 {{key}} 的變數
  "flexTemplate": "公告卡片",        // 可選，套用 /settings 定義的 Flex 樣板（可用 vars）

  "sticker": { "packageId": "446", "stickerId": "1988" },       // 可選，LINE 貼圖
  "location": { "title": "公司", "address": "台北市…", "latitude": 25.033, "longitude": 121.565 }, // 可選，位置
  "flex": { "altText": "通知", "contents": { "type": "bubble", "body": {} } }, // 可選，Flex（contents 可為物件或 JSON 字串）

  "sendAt": "2026-01-01T09:00:00+08:00", // 可選，排程時間（ISO 8601 或 epoch 毫秒）
  "delaySec": 60,                         // 可選，延遲幾秒發送（與 sendAt 擇一）
  "repeat": "0 9 * * 1-5",                // 可選，重複排程（5 欄 cron：分 時 日 月 週）

  "messages": [                           // 可選，一次送多則（每則可各自帶 to / vars）
    { "to": "小明", "template": "報價", "vars": { "amount": "100" } },
    { "to": "測試群", "text": "請查收" }
  ]
}
```

- `to`：字串或字串陣列；可填好友 / 群組名稱（需與 LINE 顯示名稱一致）或 mid。使用 `messages` 時，可省略 `to` 並在每則訊息各自帶 `to`（個人化群發）。
- 至少需提供 `text` / `file` / `image` / `video` / `audio` / `sticker` / `location` / `flex` 其中一項；多項會依序送出（image → video → audio → file → sticker → location → flex → text）。
- `image` / `video` / `audio` 可給 URL（會下載後上傳）、伺服器路徑，或 `data:` base64。
- `template`：套用 `/settings` 的「訊息模板」；`flexTemplate`：套用「Flex 樣板」。若同時提供 `text`，以 `text` 為優先。`vars` 會替換模板 / Flex 中的 `{{key}}`（未提供的變數原樣保留）。
- `sticker`：`packageId` / `stickerId`（可加 `version`）；貼圖與 Flex 走 LIFF 分享通道。
- `location`：需 `latitude` / `longitude`，`title` / `address` 可選。
- `flex`：`contents` 可為 Flex 容器物件，或代表其 JSON 的字串；`altText` 預設「Flex 訊息」。
- `sendAt` / `delaySec`：設定後改為**排程發送**（持久化於 `SCHEDULES_PATH`，最遠 30 天；重啟後未到期的排程會恢復）。`sendAt` 可為 ISO 8601、`YYYY-MM-DD HH:mm:ss` 或 epoch 毫秒；`delaySec` 為延遲秒數。回應為 `{ "ok": true, "scheduled": true, "id": "...", "runAt": "..." }`。`repeat` 為 cron 重複排程，回應會多帶 `repeat`。
- `X-Idempotency-Key`：帶了的話，成功（含排程）後會記錄；相同 key 再次送出會直接回 `{ "ok": true, "duplicate": true }`（不重複發送）。

簽章方式（設 `HMAC_SECRET` 時必填 `X-Timestamp` 與 `X-Signature`）：

```
X-Signature = HMAC-SHA256(HMAC_SECRET, `${X-Timestamp}.${原始 body}`).hex
```

| 狀態碼 | 意義 |
| --- | --- |
| 200 | 發送成功（`duplicate: true` 表示重複 key 已略過；`scheduled: true` 表示已排程） |
| 400 | `to` 為空、未提供任何訊息內容、找不到模板，或 `sendAt` / `delaySec` 無效 |
| 403 | 來源 IP 未授權、缺少 / 無效時間戳記、簽章失敗、nonce 重複 |
| 404 | 找不到目標好友 / 群組 |
| 429 | 超過速率限制 |
| 503 | 平台尚未啟用／未登入（例如 LINE 尚未登入、IM 未啟用） |
| 500 | 發送失敗（已重試） |

產生簽章範例（Linux / bash + openssl）：

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8090}"
SECRET="${HMAC_SECRET:?請先設定 HMAC_SECRET}"

TO="${1:-小明}"
TEXT="${2:-來自 curl 的測試訊息}"

# 1) body：必須與實際送出的位元組完全一致
BODY=$(printf '{"to":"%s","text":"%s"}' "$TO" "$TEXT")

# 2) 毫秒時間戳與 nonce（date 不支援 %3N 時退回秒*1000）
TS=$(date +%s%3N 2>/dev/null || echo $(( $(date +%s) * 1000 )))
NONCE=$(openssl rand -hex 16)

# 3) 簽章 = HMAC-SHA256(SECRET, "timestamp.body")
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')

# 4) 送出
curl -sS -X POST "$BASE_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "X-Timestamp: $TS" \
  -H "X-Signature: $SIG" \
  -H "X-Nonce: $NONCE" \
  --data-binary "$BODY"
echo
```

單行版本：

```bash
BODY='{"to":"小明","text":"hi"}'; TS=$(date +%s%3N); NONCE=$(openssl rand -hex 16); \
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$HMAC_SECRET" | awk '{print $NF}'); \
curl -sS -X POST http://localhost:8090/webhook \
  -H 'Content-Type: application/json' \
  -H "X-Timestamp: $TS" -H "X-Signature: $SIG" -H "X-Nonce: $NONCE" \
  --data-binary "$BODY"
```

Node.js 版本：

```sh
node -e "const c=require('crypto');const ts=Date.now().toString();const b=process.argv[1];console.log('X-Timestamp: '+ts);console.log('X-Signature: '+c.createHmac('sha256',process.env.HMAC_SECRET).update(ts+'.'+b).digest('hex'))" '{"to":"小明","text":"hi"}'
```

> `X-Nonce` 為選填（填了會防重放）；`X-Timestamp` 需為毫秒且在 `HMAC_MAX_SKEW_SEC` 容許範圍內；`body` 必須與簽章用的字串位元組完全一致（勿多加換行）。

### 驗證方式（HMAC / URL Token / API Token 可並存）

設定 `HMAC_SECRET`、`WEBHOOK_TOKEN` 或 `API_TOKEN` 任一後即啟用驗證；**任一通過即可**，三者皆空則不驗證。
每種方式各有獨立開關（`HMAC_ENABLED`／`WEBHOOK_TOKEN_ENABLED`／`API_TOKEN_ENABLED`，預設全開，可在設定頁安全區切換）；
關閉的方式視同未設定——三種全關或都沒設值時不驗證。

- **HMAC 簽章**：見上方範例。
- **URL Token**：網址帶 `?token=<WEBHOOK_TOKEN>`，或標頭 `X-Webhook-Token: <WEBHOOK_TOKEN>`。
  適合無法自訂簽章標頭的來源（例如只提供靜態 headers 的 webhook 平台）。
- **API Token（Bearer）**：標頭 `Authorization: Bearer <API_TOKEN>`。適合可設定標準 Authorization 標頭的來源。
  - 主 Token 僅有 `send` 權限；「多組 API Token」可各自勾選 `read`（唯讀：狀態/儀表板/訊息/技能狀態查詢）、`send`（呼叫 webhook）、`admin`（全部，含設定修改），留空 = 無權限。
  - Token 用量（次數、上次使用）可在設定頁查看，或呼叫 `GET /tokens/usage.json`（需登入或 admin token）。

```sh
curl -sS -X POST "http://localhost:8090/webhook?token=$WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"to":"小明","text":"hi"}'

curl -sS -X POST "http://localhost:8090/webhook" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"to":"小明","text":"hi"}'
```

### 頁面 / 操作

| 路由 | 說明 |
| --- | --- |
| `GET /` | 導向 `/dashboard` |
| `GET /dashboard` | 儀表板（需登入）：依右上角 IM 顯示該平台發送統計、狀態摘要、最近紀錄；停用平台顯示「未啟用」 |
| `GET /dashboard.json` | 儀表板 JSON（需登入或 read token），支援 `?platform=`；另回 `statsByPlatform`（各在線平台統計）與 `platforms`（含各平台狀態／QR 旗標） |
| `GET /status.json` | 狀態 / log / 目標 / 佇列 / 排程 JSON（需登入或 read token），支援 `?platform=`；停用平台回空陣列並標 `disabled: true` |
| `GET /status/qr` | 目前登入 QR 的 PNG 圖（需登入），支援 `?platform=`（WhatsApp 個人帳號模式吐 Baileys QR） |
| `GET /console` | 功能頁（需登入）：測試發送、Flex 可視化編輯、目標清單、最近紀錄、排程中的訊息 |
| `GET /skills` | 技能頁（需登入）：啟用助理、各技能設定 |
| `POST /skills` | 儲存助理與技能設定（需登入），body `{ assistant, skills }` |
| `GET /settings` | 設定頁（需登入）：左側設定卡片 + 設定表單 |
| `GET /login` | 登入畫面（無導覽列） |
| `POST /login` | 登入，body `{ user, pass }`，成功設定 session cookie（閒置 5 分鐘） |
| `POST /logout` | 登出（導覽列「登出」按鈕） |
| `GET /settings/session` | 檢查 session 是否有效（不續期，供前端偵測逾時） |
| `POST /settings/touch` | 使用者有操作時續期 session |
| `GET /settings.json` | 目前可編輯設定 JSON（需登入） |
| `GET /settings/export` | 匯出設定檔（需登入，下載 JSON） |
| `POST /settings/import` | 匯入設定（需登入），body `{ settings }` 或設定 JSON |
| `POST /settings` | 儲存設定（需登入，body = 設定 JSON） |
| `POST /settings/password` | 變更登入密碼（需登入），body `{ current, next }`；新密碼以 scrypt 雜湊存至 `AUTH_PATH` |
| `POST /settings/language` | 切換介面語言（需登入），body `{ lang }`（`zh` / `en` / `ja`） |
| `POST /settings/relogin` | 手動觸發重新登入（需登入） |
| `POST /settings/refresh` | 重新整理好友 / 群組清單（需登入） |
| `POST /settings/test` | 測試發送（需登入），body `{ to, platform?, text, file, image, video, audio, filename, sticker?, location?, flex?, sendAt?, delaySec?, repeat? }`；`platform` 省略預設 LINE |
| `POST /settings/upload` | 上傳媒體（需登入），raw body + `X-Filename`，回 `{ path, filename, bytes }` |
| `POST /settings/scheduled/cancel` | 取消排程（需登入），body `{ id, platform? }`（依平台解析，預設 LINE） |
| `POST /settings/scheduled/update` | 編輯排程（需登入），body `{ id, platform?, delaySec? \| sendAt?, repeat? }` |
| `GET /messages` | 收到的訊息頁（需登入）：關鍵字搜尋、JSON / CSV 匯出、一鍵清除 |
| `GET /messages.json` | 收到的訊息 JSON（需登入或 read token），支援 `?q=` 關鍵字、`?chat=` 對話過濾、`?limit=`（最多 1000） |
| `POST /messages/purge` | 清除訊息紀錄（需登入，記憶體＋檔案） |
| `GET /deadletter.json` | 死信列表（需登入或 read token），`?limit=`（最多 500） |
| `GET /settings/backup?password=` | 完整備份下載（需登入，設定＋登入狀態＋排程，一律加密） |
| `POST /settings/backup/restore` | 還原備份（需登入），body `{ bundle, password }`；還原前自動備份現況 |
| `GET /metrics` | Prometheus 文字格式指標（需登入或 read token）：發送數、收訊數、驗證失敗、技能執行、LLM tokens、HTTP 耗時、佇列深度、排程數 |
| `GET /tokens/usage.json` | API Token 用量統計（需登入或 admin token） |
| `GET /readme` | README 頁（需登入，輸出經消毒） |
| `GET /health` | 各平台健康狀態，全部正常才 200（否則 503）：`{ "status": "ok" \| "bad", "services": { line, telegram, ... } }` |

## 關鍵字自動回覆

在 `/settings` 的「關鍵字自動回覆」區塊：

- 勾選「啟用自動回覆」
- **回覆冷卻（秒）**：同一個聊天於此時間內只回覆一次（避免被連刷）
- 「新增規則」，每條規則包含：
  - **關鍵字**：可用 `|` 分隔多組（例如 `hi|hello|哈囉`）
  - **比對方式**：完全相符 / 包含 / 正則（regex）
  - **回覆文字**：要回的文字（可留空；支援 `{{name}}`、`{{keyword}}`、`{{text}}`）
  - **回覆圖片**：要回的圖片 URL 或路徑（可留空）
  - **檔案路徑**：要回的檔案在**執行本程式的機器**上的路徑（可留空）
  - **檔名**：顯示用檔名（選填，預設用原檔名）
  - **啟用**：個別開關
- 儲存後立即生效

行為：

- 只回覆**別人傳來的**訊息（自己的訊息不回，避免迴圈）
- 1:1 回給對方；群組則回在該群組
- 依序送出：文字 → 圖片 → 檔案
- 媒體以 E2EE 上傳並傳送
- 所有收到的訊息（含未觸發的）會記錄於 `/messages` 頁

> 此功能需要程式持續接收訊息（`client.listen()`），等同讓帳號保持在線並處理所有訊息，風險請自行評估。

## 訊息轉發規則

在 `/settings` 的「訊息轉發規則」新增規則，收到符合條件的訊息時自動轉發到指定聊天：

- **比對方式**：包含 / 正則 / 全部
- **關鍵字**：`|` 分隔多組（「全部」時可留空）
- **來源**：限定來源聊天（名稱或 mid；留空 = 全部）
- **轉發對象**：目標好友 / 群組（名稱或 mid）
- **前綴**：轉發時加在訊息前的文字（選填）
- **附上來源名稱**：開啟則在訊息前加上 `[來源]`

## 指令

在 `/settings` 的「指令」啟用後，可對本帳號傳訊息下指令（LINE 與 Telegram 皆適用）：

- **前綴**：預設 `!`
- **允許來源**：留空 = 所有人；每行一個 mid 或 chat mid（建議限制來源，可用 `!id` 取得自己的 mid）
- 指令：
  - `!help`：顯示指令說明
  - `!status`：登入狀態、好友 / 群組數、排程、佇列
  - `!id`：顯示目前 chat 與自己的 mid
  - `!send <對象> <訊息>`：透過本帳號發送訊息

## 技能（Skills）

技能是可插拔的子專案，**每個技能是一個資料夾**，放在 `src/skills/<id>/index.ts`，並以 `export default` 匯出 `SkillDefinition`。系統啟動時會掃描 `src/skills/` 下的資料夾並動態載入；**資料夾不存在或載入失敗，該技能就不會被載入**（不會報錯中斷）。

在 `/skills` 頁面（頂層導覽，非設定子選單）：

- **啟用助理**：開啟後才會處理需前綴的技能呼叫。
- **助理名稱**：預設「阿寶」，可自訂。
- **每個技能一張卡片**：
  - **未啟用的技能會收合**成一張小卡（只顯示名稱與說明），勾選「啟用」才展開設定。
  - 需要參數的技能可填寫欄位；欄位型別支援文字、密碼、下拉、以及**檔案上傳**（上傳後自動填入伺服器路徑）。
  - 需要多筆規則的技能（如關鍵字自動回覆）提供**規則列編輯器**：可「新增規則 / 刪除規則」，逐欄填寫，不需手寫 JSON。
- 技能卡片由載入到的資料夾自動產生（無法載入的技能不會出現）。

觸發格式：`<助理名稱>請幫忙 <觸發詞> <參數>`（「請幫忙 / 請幫 / 幫忙 / 麻煩 / 幫我 / 幫」皆可省略）。
技能可設定 `triggerMode`：`assistant`（預設，需前綴呼叫）或 `any`（每則訊息都呼叫，如關鍵字自動回覆）。
技能可用 `fields` 宣告參數欄位（支援 `text`/`password`/`textarea`/`select`/`file`），或用 `ruleFields` + `ruleKey` 宣告可重複的規則編輯器。
執行順序：`指令` → `技能` → `轉發規則`。

> 隨附的技能都可打包下載：執行 `node scripts/build-library.mjs` 會在 `library/` 產生技能庫靜態頁（含各技能 `.zip`），下載後到 `/skills` 上傳安裝即可使用。

### 新增一個技能

1. 建立資料夾 `src/skills/myskill/`，新增 `index.ts`：

```ts
import type { SkillDefinition } from "../types.js";

const skill: SkillDefinition = {
  id: "myskill",
  name: "我的技能",
  description: "說明",
  defaultTrigger: "查",
  fields: [], // 需要使用者填的參數欄位
  async run(ctx) {
    await ctx.reply(`你說了：${ctx.args}`);
  },
};

export default skill;
```

2. 重啟服務即會自動載入（不需修改其他程式）。移除該資料夾即停用該技能。

### 可下載技能：關鍵字自動回覆

收到訊息符合關鍵字時自動回覆（**每則訊息都會檢查，不需觸發詞**，`triggerMode: "any"`）。

- 在 `/skills` 啟用後，用「規則列編輯器」逐筆新增規則，每筆可填：
  - **關鍵字**（可用 `|` 分隔多組，例如 `報價|價目`）
  - **比對方式**（包含 / 完全相符 / 正則）
  - **回覆文字**（可用 `{{name}}`、`{{keyword}}`、`{{text}}`）
  - **回覆圖片**（可上傳檔案或填 URL / 路徑）
  - **回覆檔案**（可上傳檔案或填伺服器路徑）
  - **顯示檔名**（選填）
- **回覆冷卻（秒）**：同一個聊天於該時間內只回覆一次。
- 規則以 JSON 儲存於該技能的 `config.rules`。

### 可下載技能：火車時刻表

查詢台鐵時刻表，資料來源為交通部 **TDX 運輸資料流通服務**（官方）。

- 需自備 TDX API key：至 <https://tdx.transportdata.tw> 註冊後，於 `/skills` 的該技能填入 `TDX Client ID` / `Client Secret`。
- 用法：`阿寶請幫忙 火車 <起站> 到 <迄站> [日期] [時間]`（日期可用「今天 / 明天 / 後天」或 `2026-01-01`、`1/1`；時間為出發時間）。
- 未設定 key 時會回覆提示訊息而不報錯。

### 可下載技能：匯率換算

即時匯率（來源 `open.er-api.com`，免 key）。

- 用法：`匯率 1000 日幣 台幣`、`匯率 美金 100`（中／英文幣別皆可）。
- 只填一種幣別時，會轉成「預設目標幣別」（技能設定 `defaultCurrency`，預設 `TWD`）。

### 可下載技能：高鐵時刻

查詢台灣高鐵時刻（沿用 TDX key）。

- 用法：`高鐵 台北 到 左營 明天 08:00`（未指定時間時，從**現在**起算回覆 8 班）。

### 可下載技能：油價

查詢中油汽柴油零售牌價（來源：中油開放資料，免 key，每週更新）。

- 用法：`油價`。

### 可下載技能：統一發票 / 樂透

- 統一發票：`發票`（預設最新一期）、`發票 上一期`。來源：財政部稅務入口網（抓「最近已開獎期別」）。
- 樂透：`樂透`（大樂透）、`威力彩`；`上一期` 可查前一期。來源：台灣彩券官方 API。

### 可下載技能：郵遞區號

內建台灣郵遞區號資料，免網路。

- 用法：`郵遞區號 台北市大安區` → `106`。

### 可下載技能：空氣品質

查詢 AQI（多來源備援，免 key）。

- 用法：`空品 高雄`（預設台北）。來源以 WAQI 為主；可在技能設定填入 WAQI token 提高額度。

### 可下載技能：漢堡王 / 摩斯優惠

查詢當期優惠（HTML 擷取 + 各品牌健康狀態）。

- 用法：`漢堡王 100`、`摩斯`（可帶價格，回傳該價位附近優惠）。

## 時區

- `TIMEZONE`（`/settings` 可改，存於 `settings.json`）：IANA 時區，例如 `Asia/Taipei`、`UTC`。
- 影響範圍：**log 時間戳**（帶時區偏移，如 `2026-09-27T14:50:24+08:00`）與**技能**（例如「今天 / 明天」的判斷）。

## 多組 API Token

`/settings`「安全 / 來源」可維護**多組具名 API Token**（各自產生 / 刪除）。呼叫 webhook 時帶 `Authorization: Bearer <token>`，任一組或上方單一 API Token / HMAC / URL Token 通過即可。

## 設定匯出 / 匯入

`/settings`「匯出 / 匯入」：

- **匯出設定**：點擊後輸入一組密碼，將整份設定（**含所有密鑰**：HMAC secret、Webhook token、API token、SMTP 密碼、Telegram/WhatsApp token 等）以 **AES-256-GCM** 加密後下載（`.enc.json`）。留空密碼則下載明文 JSON（不建議）。
- **匯入設定**：上傳 JSON；若為加密檔會提示輸入匯出時的密碼，解密後覆蓋目前設定（即時套用）。密碼錯誤或檔案遭竄改會被拒絕。

> 匯出檔案一律只從**現行生效中的設定**產生，不會是舊值。

## 訊息模板與排程

### 訊息模板

在 `/settings` 的「訊息模板」區塊新增模板，每筆包含**名稱**與**內容**；內容可用 `{{key}}` 變數。

呼叫 webhook 時帶 `template` 名稱與 `vars` 物件即可套用：

```sh
curl -sS -X POST "http://localhost:8090/webhook?token=$WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"to":"小明","template":"每日報價","vars":{"name":"小明","amount":"100"}}'
```

- 模板內容 `您好 {{name}}，今日金額 {{amount}}` → `您好 小明，今日金額 100`。
- 未提供的變數會**原樣保留**（例如 `{{unknown}}`）。
- 若同時提供 `text`，以 `text` 為優先，模板僅在 `text` 為空時採用。
- `vars` 也會套用到直接提供的 `text`。

### 排程 / 延遲發送

在 webhook body 加上 `delaySec`（秒）或 `sendAt`（ISO 8601 或 epoch 毫秒）即可排程：

```sh
# 60 秒後發送
curl -sS -X POST "http://localhost:8090/webhook?token=$WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"to":"小明","text":"提醒","delaySec":60}'
```

- 成功回應：`{ "ok": true, "scheduled": true, "id": "<id>", "runAt": "<ISO>" }`。
- 排程**持久化**於 `SCHEDULES_PATH`，最遠 30 天；**程序重啟後未到期的排程會自動恢復**。
- 加上 `repeat`（5 欄 cron，例如 `0 9 * * 1-5` 表週一至五 09:00）可建立**重複**排程。
- `/console` 頁面的「排程中的訊息」可檢視、**改變時間**與取消（`POST /settings/scheduled/update` / `cancel`）。

## 統計 / 儀表板

- 登入後首頁為 **`/dashboard`**：顯示總發送數、成功 / 失敗、成功率、近 `STATS_DAYS` 日長條圖與訊息類型分佈。
- 每次發送（含 webhook、測試、排程、自動回覆）成功或失敗都會記錄於 `STATS_PATH`（JSONL，記憶體保留最近 5000 筆），並在啟動時載入。
- 統計**依平台分別累計**（每筆記錄帶 `platform`；舊資料無標記視為 LINE），儀表板一次只顯示右上角所選平台的統計。
- 狀態摘要（登入狀態、QR / PIN、好友數、佇列、最後發送…）也整合在同一頁。

## 媒體上傳

- `/console` 測試發送可**直接上傳檔案**（存到 `UPLOADS_PATH`），上傳後自動帶入圖片欄位；`POST /settings/upload` 接受 raw body 與 `X-Filename`。
- 發送可接受 URL、伺服器路徑或 `data:` base64；影片 / 語音分別對應 `video` / `audio` 欄位。

## 訊息記錄（/messages）

- 記錄**別人傳給本帳號**的訊息（自己送出的不記），涵蓋 1:1 與群組。
- 預設只存在記憶體（最多 300 筆），**重啟即清空**。
- 於 `/settings` 勾選「**持久化收到的訊息**」後，訊息會以 JSONL 追加寫入 `MESSAGES_PATH`
  （預設 `./data/messages.jsonl`，於 `.env` 設定）；重啟時會載入最近 300 筆。
- 檔案超過 5MB 會自動輪替（保留 3 個舊檔）。
- 只記錄文字；圖片 / 檔案訊息的內容不記錄。

## 運作流程

1. 啟動 HTTP server
2. 背景登入 LINE：優先使用 `storage.json` 的 token，失效則改用 QR（終端機與狀態頁會顯示可掃描的 QR 圖）
3. 登入後抓取好友與群組，建立名稱→mid 對照表
4. 定時健康檢查；失效時寄信 + 自動重登，狀態顯示於 `/dashboard`
5. Webhook 發送進入佇列：節流 → 失敗退避重試 → 回應結果

詳見 [`docs/architecture.md`](docs/architecture.md)。

## 各平台申請與設定

LINE / Telegram / WhatsApp / Teams 的申請流程、如何產生本系統所需設定值（Bot Token、secret、chat_id / 電話號碼、Entra App、驗證方式等），
與各平台端點對照，詳見 [`docs/IM-setup.md`](docs/IM-setup.md)。

## 部署（更新程式、保留狀態）

`settings.json` 是**執行期資料庫**（助理開關／技能啟用與參數／目標對照／UI 產生或編輯的密鑰都在裡面）；`.env`、`storage.json`、`data/`、`logs/` 同理。
**部署只更新程式碼，絕不覆蓋這些檔案**，否則每次上線都會重置設定（例如助理會被關回預設的關閉）。

Git 部署（檔案已在 `.gitignore`，`git pull` 不會動到它們）：

```sh
git pull
npm ci
npm run build
pm2 restart line-webhook
```

> 切勿在伺服器上執行 `git clean -fdx` 或重新 clone，否則會刪掉未追蹤的 runtime 檔案。
>
> **每次部署都要跑 `npm ci`**：若新版本新增了依賴（例如 WhatsApp 個人帳號模式需要 `@whiskeysockets/baileys`），沒安裝會導致該功能載入失敗（嚴重時服務起不來 → nginx 502）。

rsync 部署（**不要**用範圍過大的 `--delete`，並排除狀態檔）：

```sh
rsync -av \
  --exclude='.env' --exclude='settings.json' --exclude='storage.json' \
  --exclude='data/' --exclude='logs/' --exclude='node_modules/' --exclude='dist/' \
  ./ user@host:/path/line-webhook/
ssh user@host 'cd /path/line-webhook && npm ci && npm run build && pm2 restart line-webhook'
```

**更保險**：把 runtime 檔案放到部署目錄外，並在 `.env` 指定（見 `.env.example` 的「正式部署建議」）：
`SETTINGS_PATH`、`STORAGE_PATH`、`AUTH_PATH`、`MESSAGES_PATH`、`SCHEDULES_PATH`、`STATS_PATH`、`UPLOADS_PATH`、`SKILLS_PATH`、`CACHE_PATH`、`LOG_FILE`。
如此一來部署目錄可整包覆蓋，狀態完全不受影響。

## Docker

```sh
docker compose up -d --build
```

`docker-compose.yml` 會把 `./data` 掛載為 `/app/data` 保存 `storage.json` 與 log。
首次啟動請查看容器日誌取得 QR 網址：

```sh
docker compose logs -f
```

## 專案結構

```
src/
  index.ts              啟動 / graceful shutdown
  config.ts             .env 驗證（zod）與 bootstrap 設定
  settings.ts           可線上編輯設定（settings.json 載入 / 儲存 / 套用）
  types.ts              型別
  state.ts              登入狀態儲存
  messages.ts           收到的訊息記錄（ring buffer + 可選持久化）
  stats.ts              發送統計（JSONL + 儀表板彙總）
  logger.ts             log（console + 檔案 + 記憶體 + 輪替）
  rotate.ts             檔案輪替工具
  line/client.ts        LINE 登入 / 聯絡人 / 發送（文字 / 檔案 / 圖片 / 影片 / 語音 / 貼圖 / 位置 / Flex）/ 自動回覆 / 重登
  line/queue.ts         發送佇列（重試 + 節流）
  line/scheduler.ts     排程 / 延遲 / 重複發送（持久化）
  line/cron.ts          cron 表達式解析與下次執行時間
  messaging/            多 IM 傳輸抽象（types / services 註冊表 / dispatch 共用管線 / text / media）
  telegram/client.ts    Telegram Bot API 轉接（發送 / 接收正規化 / 媒體上傳 / 貼圖與 Flex 降級）
  whatsapp/client.ts    WhatsApp Cloud API 轉接（發送 / webhook 接收驗簽 / 24h 視窗感知）
  whatsapp/web-client.ts WhatsApp 個人帳號轉接（Baileys 長連線，QR 登入；動態載入，缺依賴不影響啟動）
  teams/client.ts       Teams 企業 Bot 轉接（Entra 取 token / Bot Connector REST / JWT 驗簽 / Adaptive Card 轉譯；無新依賴）
  settings-crypto.ts    設定匯出加密（AES-256-GCM + scrypt）
  icons/                各 IM 去背 icon（右上角切換鈕使用，以 base64 內嵌）
  skills/index.ts       技能對外匯出（loadSkills / getSkill）
  skills/loader.ts      掃描資料夾並動態載入技能
  skills/train/index.ts 火車時刻表技能（TDX API，一個技能一個資料夾）
  skills/auto-reply/index.ts 關鍵字自動回覆技能（triggerMode: any）
  skills/types.ts       技能介面型別
  time.ts               時區格式化工具
  middleware/session.ts 管理頁登入 session（閒置 5 分鐘）
  middleware/hmac.ts    HMAC 簽章 + 防重放 + idempotency
  middleware/ip.ts      IP 白名單
  middleware/rateLimit.ts 接收端速率限制
  notify/mailer.ts      Email 通知
  monitor/token.ts      健康檢查與重登
  webhook/server.ts     HTTP server（webhook + 狀態 / 設定 / 訊息 / ReadMe 頁）
docs/architecture.md    架構圖（含多平台歸屬對照表與新增 IM 檢查清單）
docs/IM.md              多平台規劃（LINE / Telegram / Teams / WhatsApp / Discord 進度）
docs/IM-setup.md        LINE / Telegram / WhatsApp / Teams 申請與設定說明
tests/                  單元測試（`npm test`）
```

## 疑難排解

- **一直顯示「待驗證」**：用 LINE 內建掃描器掃終端機或 `/dashboard` 上的 QR 圖，或點儀表板的驗證連結在手機開啟。
- **找不到目標（404）**：名稱需與顯示名稱完全相同；建議改用原生 ID（LINE 用 mid、Telegram 用 chat_id、WhatsApp 用電話號碼、Teams 用 conversation id），或在設定頁目標對照設定。
- **收不到 Email**：確認 `SMTP_*` 與 `MAIL_FROM` / `MAIL_TO` 都已設定。
- **對外接收 webhook**：本機需用 ngrok / Cloudflare Tunnel 打通道；記得設定 `HMAC_SECRET`。
- **被擋 403 簽章錯誤**：確認簽章字串為 `${timestamp}.${body}`，且時間戳在誤差範圍內。
- **某 IM 沒反應**：先看右上角是否切到該平台；停用的平台儀表板會顯示「未啟用」空白狀態。Teams 主動推播前需先讓 Bot 收到該對話一次訊息；WhatsApp Cloud 主動推播受 24 小時視窗限制。
- **啟動即退出（未啟用任何驗證）**：三種 webhook 驗證全關時服務拒絕啟動；請至少設定一種，或以 `ALLOW_OPEN_WEBHOOK=true` 明確允許（僅測試用）。
- **部署後 nginx 502**：服務沒起來，先看 `pm2 logs`；常見原因是忘了跑 `npm ci`（新依賴未安裝）。
