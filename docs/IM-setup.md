# IM 申請與設定說明書

本文件說明如何為每個通訊平台（LINE、LINE 官方 Messaging API、Telegram、WhatsApp、Teams、Discord）申請服務，並產生本系統所需的設定值。

- 設定分兩層：`.env`（bootstrap，無法在網頁改）與 `/settings`（線上編輯，存於 `settings.json`）。
- 各平台的設定都在 **`/settings` 頁面**對應的卡片中填寫，填完按「儲存設定」。
- 右上角有 **全域 IM 切換**，切到哪個平台就只顯示該平台的專屬設定。
- 填錯或未啟用時，該平台的接收／發送端點會回 `503`，不影響其他平台。

路徑總表：

| 平台 | 發送端點 | 接收端點 | 目標對照欄位 |
| --- | --- | --- | --- |
| LINE | `POST /webhook` | 長連線（自 bot，無 webhook） | 設定 → 目標對照（名稱=mid） |
| LINE 官方 | `POST /webhook/line-official` | `POST /line-official/webhook` | 設定 → LINE 官方 → 目標對照 |
| Telegram | `POST /webhook/tg` | `POST /tg/update` | 設定 → Telegram Bot → 目標對照 |
| WhatsApp | `POST /webhook/wa` | `GET/POST /wa/webhook` | 設定 → WhatsApp → 目標對照 |
| Teams | `POST /webhook/teams` | `POST /teams/messages` | 設定 → Microsoft Teams → 目標對照 |
| Discord | `POST /webhook/discord` | Gateway 長連線（無 webhook） | 設定 → Discord → 目標對照 |

> 對外網址假設為 `https://你的網域`（本專案範例：`https://linehook.asianoel.space`）。所有接收端點都需能被平台伺服器以 HTTPS 呼叫。

---

## 1. LINE

本專案使用非官方 LINE API（`@evex/linejs`）以**個人帳號（selfbot）**登入，因此不需要向 LINE 官方申請 Bot。

> ⚠️ selfbot 違反 LINE 服務條款，帳號有被停權風險，建議使用備用帳號。

### 需要什麼
- 一支 **LINE 帳號** + 可收驗證的手機（登入時需在手機上確認 / 掃 QR）。

### 產生本系統所需資訊
- 登入 **QR Code / PIN**：由系統啟動時自動產生，顯示於終端機與 `/dashboard` 狀態頁，用手機 LINE 掃描即可。
- 登入成功後 **authToken** 自動存到 `storage.json`（由 `STORAGE_PATH` 決定），之後自動登入。

### 設定步驟
1. `/settings` → 切到右上角 **LINE**。
2. **裝置類型**（`LINE_DEVICE`）：預設 `DESKTOPWIN`，一般不用改。
3. **顯示名稱 / 機型**（`LINE_DEVICE_NAME` / `LINE_MODEL_NAME`）：LINE 上顯示的裝置名稱；**修改後需重新登入才生效**（刪除 `storage.json` 後重啟）。
4. **目標對照**（名稱=mid）：每行 `名稱=mid`。mid 可從 `/console` 的「目標清單」看到，或用聊天中的 `!id`（若已開指令）取得；也可直接填 LINE 顯示名稱（較不建議，名稱可能重複）。
5. 儲存後，到 `/dashboard` 掃 QR 完成首次登入。

### 端點 / API 呼叫
- 發送：`POST https://你的網域/webhook`（驗證方式見文末「共用驗證」）。

---

## 1B. LINE 官方（Messaging API，合規雙軌）

與第 1 節的 selfbot **雙軌並存**：兩者是獨立平台（`line` 與 `line-official`），統計、排程、目標對照都分開，可同時上線。
官方版本走 LINE 官方 Messaging API，**沒有 selfbot 的停權風險**，也是長期唯一合規的做法。

### 需要什麼
- 一個 **LINE 帳號**（用來建立 LINE 官方帳號）。
- **LINE Developers** 帳號與 **Provider**（免費即可）。
- 對外可達的 **HTTPS** 網址（webhook 與本機媒體都要）。

### 申請步驟
1. 到 [LINE Developers Console](https://developers.line.biz/) → **Create a new provider**（或沿用既有）。
2. **Create a Messaging API channel**（對應一個 LINE 官方帳號）→ 記下：
   - **Channel access token (long-lived)**：Messaging API 分頁 → Issuing → 產生（也可用短期 token）。→ `LINE_OFFICIAL_CHANNEL_ACCESS_TOKEN`
   - **Channel secret**：Basic settings 分頁。→ `LINE_OFFICIAL_CHANNEL_SECRET`
3. Messaging API 分頁設定：
   - **Use webhook** → 開啟（必須）。
   - **Auto-reply messages** → 建議**關閉**（否則 LINE 官方自動回覆會跟本系統的回覆疊在一起）。
   - **Greeting message** 視需求。
4. **Webhook URL** 填 `https://<你的網域>/line-official/webhook`，或把網址填進 `LINE_OFFICIAL_WEBHOOK_URL`（系統啟動時會用 `PUT /v2/bot/channel/webhook/endpoint` 自動註冊）。填完按 **Verify** 應顯示成功。
5. 邀請 Bot：把官方帳號加為好友（一對一）或加入群組（群組需在 LINE 官方帳號管理後台開啟「允許加入群組」）。
6. `.env` 或 `/settings` 設定：
   - `LINE_OFFICIAL_ENABLED=1`
   - Channel access token / Channel secret / Webhook URL
   - **`MEDIA_PUBLIC_URL=https://<你的網域>`**（本機檔案要送給 LINE 必需，見下方「重要限制」）
7. `/settings` → 右上角切到 **LINE 官方**，按「儲存設定」→ 重啟。
8. 對 Bot 傳一則訊息，到 `/messages` 頁找到 **chatMid**（`U…`／`c…`／`Ra…`），填入「目標對照」即可主動推播。
   （收到訊息的對話也會自動記住，僅供名稱對照顯示用。）

### 端點 / API 呼叫
- 發送：`POST https://你的網域/webhook/line-official`（驗證方式見文末「共用驗證」）。
- 接收：`POST https://你的網域/line-official/webhook`（驗 `X-Line-Signature`，**channel secret 未設定一律 503 拒絕**）。

### 測試是否成功
1. `/dashboard` 右上角切到 **LINE 官方**，狀態應顯示**已登入**（日誌會出現「LINE 官方 Bot 已連線」）。
2. 對官方帳號傳訊息，本系統應回覆；或呼叫 `POST /webhook/line-official` 主動發送。

#### 常見問題
- **webhook 403**：簽章不符 → 確認 `Channel secret` 正確，且**不要**讓 proxy 重新編碼 body（需保留原始 bytes）。
- **webhook 503**：channel access token 或 channel secret 沒設，或未啟用。
- **本機圖片送不出去（400 / 要求 HTTPS）**：`MEDIA_PUBLIC_URL` 沒設或不是 `https://`。
- **429 Too Many Requests**：佇列會自動退避重試；也可調大 `SEND_MIN_INTERVAL_MS`。
- **額度用盡**：push／multicast／broadcast 佔每月額度（free 方案依地區 200～500 則），**回覆（reply）不佔**。系統會在收到訊息後 1 分鐘內自動改用 replyToken，逾時才退回 push。

### 重要限制
- 圖片／影片／語音／檔案的來源**必須是 HTTPS URL**（LINE 沒有「上傳二進位」的 API）。
  本系統會把 `data/uploads`、`data/cache` 內的檔案轉成 **HMAC 簽章＋24 小時時效**的 `/media/<exp>/<sig>/<name>` 公開連結；`data:` URL 會先解碼暫存到上傳目錄。
  → 因此 `MEDIA_PUBLIC_URL` 必須是**對外 HTTPS 網址**。
- 文字單則上限 **5000 字元**（超過自動分段）；一次請求最多 5 則訊息。
- **Flex 原生**呈現（非降級）；位置原生；**貼圖**以 LINE 官方貼圖送出，無效 ID 會降級成文字說明。
- **語音**需要長度資訊：本機檔案會解析 WAV／MP4／MP3 估算；抓不到長度（例如遠端音訊）會改以**檔案附件**送出。

---

## 2. Telegram

透過官方 **Bot API**，用 `@BotFather` 建立 Bot。

### 需要什麼
- 一個 Telegram 帳號（用來跟 BotFather 對話）。
- 對外可連的網址（HTTPS）。

### 申請與產生資訊
1. **建立 Bot / 取得 Bot Token**：
   - 在 Telegram 搜尋 **@BotFather** → 傳 `/newbot`。
   - 依指示給 Bot 一個名稱與 username（結尾需為 `bot`）。
   - BotFather 會回一串 **HTTP API Token**，格式如 `123456789:ABCdef...` → 填入 **Bot Token**（`TELEGRAM_BOT_TOKEN`）。
2. **Webhook Secret Token**（`TELEGRAM_SECRET_TOKEN`，建議設定）：
   - 這不是 Telegram 發給你的，而是**你自己自訂**的字串，稍後註冊 webhook 時一併告訴 Telegram。
   - 限制：**1–256 字元，只允許 `A-Z a-z 0-9 _ -`**。
   - 可點設定頁的「隨機產生」按钮（產生 64 字元 hex）。
   - 之後 Telegram 每次呼叫你的 webhook，都會帶標頭 `X-Telegram-Bot-Api-Secret-Token`，系統據此驗證來源。
3. **Webhook URL**（`TELEGRAM_WEBHOOK_URL`）：
   - 填 `https://你的網域/tg/update`。
   - 有填的話，系統啟動時會**自動呼叫 `setWebhook` 註冊**（含上面的 secret token）。
4. **目標對照**（名稱=chat_id）：
   - `chat_id` 取得方式：把 Bot 加入群組或先對它私訊，再呼叫
     `https://api.telegram.org/bot<Token>/getUpdates` 查看 `message.chat.id`
     （群組為負數，如 `-1001234567890`）；或用 `@userinfobot`。
   - 也可以直接填 `@username`（系統支援）。
   - 每行 `名稱=chat_id`。

### 測試是否成功
- 對你的 Bot 傳一則訊息（例如「助理名稱請幫忙」），應會收到回覆。
- 或呼叫 `https://api.telegram.org/bot<Token>/getWebhookInfo` 確認 `url` 正確、`last_error` 為空。

### 端點
- 發送：`POST https://你的網域/webhook/tg`
- 接收：`POST https://你的網域/tg/update`（由 Telegram 呼叫，系統以 secret token 驗證）

### 常見問題
- **收不到訊息**：確認 `Webhook URL` 正確、憑證有效、`getWebhookInfo` 無錯誤。
- **改了 secret token 後失效**：Telegram 只在 `setWebhook` 時記住它；改完請**重啟**（會自動重新註冊）或手動 `setWebhook`。

---

## 3. WhatsApp

WhatsApp 有**兩種模式**，在 `/settings` → WhatsApp → **模式** 選擇：

| 模式 | 說明 | 適合 |
| --- | --- | --- |
| **Cloud API**（官方） | Meta 官方商業 API，穩定合法 | 正式、企業用途 |
| **個人帳號（WhatsApp Web）** | 以 QR 登入**個人號**（Baileys 實作） | 不想申請 Business、只想用個人號 |

> ⚠️ 個人帳號模式屬非官方逆向（與 LINE selfbot 同性質），**違反 WhatsApp 服務條款、帳號有被停權風險**。請自行評估，建議使用備用號。

---

### 3A. Cloud API 模式

透過 **Meta for Developers** 的 WhatsApp Cloud API（免費本體，business-initiated 訊息按模板收費）。

#### 需要什麼
- Meta（Facebook）帳號。
- Meta Business 帳號（企業驗證視用量而定）。
- 一個**專用電話號碼**（不可與現有 WhatsApp 個人帳號重複）。

#### 申請與產生資訊
1. 前往 **developers.facebook.com** → 建立 App → 選 **Business** 類型。
2. 在 App 中加入 **WhatsApp** 產品。
3. 取得以下三項：
   - **Phone Number ID**（`WHATSAPP_PHONE_NUMBER_ID`）：WhatsApp → API Setup 頁顯示的「Phone number ID」（一串數字）。
   - **Access Token**（`WHATSAPP_ACCESS_TOKEN`）：API Setup 頁有**臨時權杖（24h）**可測試；正式請建立 **System User 永久權杖**（Business Settings → Users → System Users，授予 `whatsapp_business_messaging` 權限）。
   - **App Secret**（`WHATSAPP_APP_SECRET`）：App → Settings → Basic → App Secret（點 Show）。用於驗證進站 webhook 的簽章。
4. **Webhook Verify Token**（`WHATSAPP_VERIFY_TOKEN`）：
   - 這是**你自己自訂**的字串，稍後在 Meta 設定 Webhook 時填入，兩邊一致即可。
5. **Graph API 版本**（`WHATSAPP_API_VERSION`）：預設 `v21.0`，Meta 升版時可調。
6. **目標對照**（名稱=電話號碼）：
   - 每行 `名稱=號碼`，號碼為 **E.164 格式、不含 `+`**，例如 `886912345678`。
   - 測試階段只有加到「收件者測試清單」的號碼能收到訊息。

#### 設定 Webhook（在 Meta 後台）
- Callback URL：`https://你的網域/wa/webhook`
- Verify Token：填與系統 `Webhook Verify Token` **相同**的值。
- Meta 會先發 **GET** 驗證（系統比對 `hub.verify_token` 並回 `hub.challenge`）；通過後才開始 POST 推播訊息。
- Subscribe 欄位請勾選 **messages**。

#### 端點
- 發送：`POST https://你的網域/webhook/wa`
- 接收：`GET /wa/webhook`（訂閱驗證）、`POST /wa/webhook`（訊息，驗 `X-Hub-Signature-256`）

#### 重要限制
- **24 小時視窗**：使用者最後一次傳訊後 24 小時內，可自由回覆；超過後**主動推播（排程、到價通知）需使用預先審核的訊息模板**，否則會被拒。
- 系統遇到此情況會記錄警告並提示改用模板。

---

### 3B. 個人帳號模式（WhatsApp Web）

#### 需要什麼
- 一支 **WhatsApp 個人帳號 + 手機**（登入時用手機掃 QR）。

#### 產生本系統所需資訊
- **登入 QR**：系統啟動後在 `/dashboard`（右上下拉切到 **WhatsApp**）顯示，用手機 WhatsApp → **連結裝置** 掃描。
- 登入憑證自動存到 **Session 儲存目錄**（`WHATSAPP_WEB_AUTH_PATH`，預設 `./data/whatsapp-web`）：
  - **刪除此目錄 = 登出**，下次啟動需重新掃 QR。
- **目標對照**（名稱=電話號碼）：同 Cloud，每行 `名稱=號碼`（E.164 不含 `+`）。
  - 可先用 `@userinfobot` 之類或請對方提供號碼；號碼即對方 WhatsApp 註冊號。

#### 設定步驟
1. `/settings` → WhatsApp → 模式選 **個人帳號（WhatsApp Web）**。
2. （選填）調整 **Session 儲存目錄**，填好**目標對照**。
3. 按「儲存設定」→ **重啟服務**（`pm2 restart`）。
4. 到 `/dashboard`，右上角切到 WhatsApp，掃描 QR 完成登入。
5. 之後即可收訊（關鍵字自動回覆 / 技能）與發送（`POST /webhook/wa`）。

#### 端點
- 發送：`POST https://你的網域/webhook/wa`
- 接收：**不需要** webhook（透過長連線接收）；`GET/POST /wa/webhook` 在此模式回 `503`。

#### 重要限制
- 非官方 API，**有被停權風險**；Baileys 為社群套件，WhatsApp 伺服器改版時可能需更新。
- 同樣有非正式的「未互動即無法主動傳訊」實務限制。
- 系統遇到此情況會記錄警告並提示改用模板。
- Flex 卡片與 LINE 貼圖在 WhatsApp 會降級為文字；位置訊息用原生 location 支援。

---

## 4. Microsoft Teams（企業 Bot，單一模式）

Teams **沒有個人帳號模式**（不像 WhatsApp 可選個人帳號）。Teams Bot 一定走 **Azure Bot + M365 tenant 的企業身分**，
系統以不引 SDK 的 REST 直連對接（Bot Framework SDK 已歸檔）。

### 需要什麼
- **Azure 訂閱**（需能建立 Azure Bot resource）。
- **M365 tenant**（有 Teams，並允許 sideloading 上傳自訂 App）。
- 對外可連的網址（HTTPS），作為 Bot 的訊息端點。

### 申請與產生資訊
1. 建立 **Entra 應用程式註冊**（single-tenant 就用自家 tenant）：
   - 到 Microsoft Entra admin center → 應用程式 → 應用程式註冊 → 新增註冊。
   - 記下 **應用程式（用戶端）識別碼** → 填 `Microsoft App ID`（`TEAMS_APP_ID`）。
   - 記下 **目錄（租用戶）識別碼** → 填 `Tenant ID`（`TEAMS_TENANT_ID`）。
   - 在「憑證與密碼」新增 **用戶端密碼** → 填 `Client Secret`（`TEAMS_APP_PASSWORD`，只顯示一次，遺失需重建）。
2. 建立 **Azure Bot** resource：
   - 到 Azure Portal → 建立「Azure Bot」→ 類型選 **SingleTenant** → App ID 填上一步的。
   - 定價層選 Free（F0）即可。
3. 在 Azure Bot → **設定** → **訊息端點** 填：
   - `https://你的網域/teams/messages`
   - 之後 Bot Connector 收到訊息就會 POST activity 到這裡；系統以微軟公開金鑰驗證 Bearer JWT（audience＝你的 App ID），不合直接 403。
4. 把 Bot 裝進 Teams：
   - 到 Teams 系統管理中心（或 App 上傳）開啟 **sideloading**。
   - 做一個最小 Teams App package（manifest 指向你的 Bot ID），上傳到要用的團隊/個人。
   - Bot 收到 `conversationUpdate`（被加入）與 `message` activity。

### 設定步驟
1. `/settings` → 右上角切到 **Teams**。
2. 勾選**啟用 Teams**，填 `Microsoft App ID`、`Client Secret`、`Tenant ID`。
3. `Service URL` 通常留預設（`https://smba.trafficmanager.net/teams`）；系統在第一次收到該對話的訊息後會自動記住實際值。
4. **目標對照**（名稱=conversation id）：每行 `名稱=19:xxx@thread.v2`（頻道）或 `a:xxx`（個人）。**收過訊息的對話會自動記住，通常不需手填**；主動推播前建議先讓 Bot 收到該對話一次訊息。
5. 按「儲存設定」→ 重啟。

### 測試是否成功
- 在 Teams 裡對 Bot 傳一則訊息（例如「助理名稱請幫忙」），應會收到回覆。
- 或呼叫 `POST https://你的網域/webhook/teams` 發送測試（驗證方式同共用驗證）。

#### 常見問題
- **收不到訊息**：確認 Azure Bot 的訊息端點是 `https://你的網域/teams/messages`、憑證有效、App 已裝進 Teams。
- **主動推播 404/失敗**：該對話還沒被 Bot 收過訊息（serviceUrl 未知），先對 Bot 傳一次。
- **JWT 驗證失敗**：App ID 與 Azure Bot 的不一致，或 token 過期／audience 錯誤。

### 端點
- 發送：`POST https://你的網域/webhook/teams`
- 接收：`POST https://你的網域/teams/messages`（由 Bot Connector 呼叫，驗 Bearer JWT）

### 重要限制
- Flex 卡片會**轉譯為 Adaptive Card** 直接呈現（好消息：不是降級）；貼圖降級為文字；位置訊息附 Bing 地圖連結。
- 無 24 小時視窗限制，但 Teams 訊息有長度上限，長文會自動分段。
- sideloading 僅限自有 tenant；要全公司散佈需走 Teams Store（另案）。

---

## 5. Discord（Bot，Gateway 長連線）

Discord 與 LINE 同屬**長連線**模式：收訊不靠 webhook，由本程式以 WebSocket 連上 Discord Gateway，
因此**不需要公開網址給 Discord 呼叫**（發送仍走 REST，可由 `/webhook/discord` 呼叫）。

### 需要什麼
- 一個 Discord 帳號（用來在 Developer Portal 建 Bot）。
- 若要收「一般文字頻道」訊息，需在伺服器開 **Developer Mode**（使用者設定 → 進階 → 開發者模式），方便右鍵複製頻道 ID。

### 申請步驟

1. 到 [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** 建立應用程式。
2. 左側 **Bot** → **Add Bot**（或沿用預設 Bot）。
3. 取得 **Token**（**Reset Token**，只顯示一次）：
   - 對應 `DISCORD_BOT_TOKEN`（或 `/settings` → Discord → Bot Token）。
   - ⚠️ Token 等同 Bot 密碼，**不要**提交到 git 或貼到公開處。
4. 同一頁把 **Privileged Gateway Intents** 的 **MESSAGE CONTENT INTENT** 開啟
   （不開的話 Bot 收得到事件但 `content` 為空，系統會判定為空訊息忽略）。
5. **Installation** → **Install Locations** 確認可安裝到伺服器（預設 `bot` scope 即可）。
6. 把 Bot **邀請進你的伺服器**：
   - OAuth2 → URL Generator → 勾 `bot` scope（需要讀訊息/發訊息權限）→ 複製 URL 貼到瀏覽器加入。
7. 取得目標 **頻道 ID**：Discord 開發者模式下，對頻道右鍵 → **複製頻道 ID**（17–20 碼數字）。
8. `/settings` → 右上角切到 **Discord**：
   - 勾選**啟用 Discord Bot**、貼上 Bot Token。
   - 目標對照填 `名稱=頻道ID`，每行一筆，例如 `客服=123456789012345678`。
9. 按「儲存設定」→ 重啟（Gateway 連線在啟動時建立）。

### 測試是否成功
- `/dashboard` 右上角切到 Discord，狀態應顯示**已登入**（日誌會出現「Discord Bot 已連線」）。
- 在伺服器頻道對 Bot 說話（或用 `/console` 發送），應收到回覆／訊息送出。
- 或呼叫 `POST https://你的網域/webhook/discord` 發送測試（驗證方式同共用驗證）。

#### 常見問題
- **狀態一直「連線中／需人工」**：確認 Token 正確、Bot 有加入伺服器、網路可連 `wss://gateway.discord.gg`。
- **收到事件但內容為空**：MESSAGE_CONTENT INTENT 沒開。
- **發送 403 Missing Access**：Bot 不在該頻道／伺服器，或缺少讀取與發言權限。
- **發送 429**：觸發 Discord 速率限制，佇列會自動退避重試。

### 端點
- 發送：`POST https://你的網域/webhook/discord`
- 接收：Gateway 長連線（`wss://gateway.discord.gg`，**無 webhook 端點**）

### 重要限制
- 文字 / 圖片 / 檔案 / 影片 / 語音為**原生**；貼圖降級為文字說明、位置附 Google 地圖連結、Flex 轉為 **Embed**（標題＋文字）。
- 單則訊息上限 2000 字元，超過自動分段。
- 檔案上傳受 `MAX_BODY_MB` 限制。

---

## 共用驗證（`/webhook*` 發送端點）

LINE（selfbot）、LINE 官方 Messaging API、Telegram、WhatsApp、Teams、Discord 的**發送**端點共用同一套驗證（任一通過即可）：

| 方式 | 設定 | 呼叫方式 |
| --- | --- | --- |
| HMAC-SHA256 | `HMAC_SECRET` / `HMAC_ENABLED` | 標頭 `X-Timestamp`、`X-Signature = HMAC-SHA256(secret, "{ts}.{rawBody}")`、`X-Nonce` |
| URL Token | `WEBHOOK_TOKEN` / `WEBHOOK_TOKEN_ENABLED` | 網址 `?token=...` 或標頭 `X-Webhook-Token` |
| API Token（Bearer） | `API_TOKEN` / 具名 `apiTokens`（可設 scopes `read`/`send`/`admin`） | 標頭 `Authorization: Bearer <token>` |

- 三者各有獨立開關，**全關或皆未設定 = 開放模式**（開機時會警告）。
- 接收端點（`/tg/update`、`/wa/webhook`、`/teams/messages`、`/line-official/webhook`）**不受**這套影響，各用平台自身的密鑰驗證（Telegram secret token、WhatsApp app signature、Teams Bearer JWT、LINE channel secret）。

---

## 快速對照表：各平台需要的資訊從哪來

| 資訊 | 來源 | 對應設定欄位 |
| --- | --- | --- |
| LINE 登入 | 系統產生 QR，手機掃描 | （自動，無欄位） |
| LINE 目標 mid | `/console` 目標清單 / `!id` | 目標對照 |
| LINE 官方 Channel access token | LINE Developers Console → Messaging API → Issuing | `LINE_OFFICIAL_CHANNEL_ACCESS_TOKEN` |
| LINE 官方 Channel secret | LINE Developers Console → Basic settings | `LINE_OFFICIAL_CHANNEL_SECRET` |
| LINE 官方 userId／groupId | 對 Bot 傳訊息後到 `/messages` 看 chatMid | 目標對照（`名稱=U…`） |
| 本機媒體對外網址 | 自己的域名（需 HTTPS） | `MEDIA_PUBLIC_URL` |
| Telegram Bot Token | @BotFather `/newbot` | `TELEGRAM_BOT_TOKEN` |
| Telegram secret | 自己自訂（可用「隨機產生」） | `TELEGRAM_SECRET_TOKEN` |
| Telegram chat_id | `getUpdates` / @userinfobot | 目標對照 |
| WhatsApp Phone Number ID | Meta App → WhatsApp → API Setup | `WHATSAPP_PHONE_NUMBER_ID`（Cloud） |
| WhatsApp Access Token | Meta App API Setup（測試）/ System User（永久） | `WHATSAPP_ACCESS_TOKEN`（Cloud） |
| WhatsApp App Secret | Meta App → Settings → Basic | `WHATSAPP_APP_SECRET`（Cloud） |
| WhatsApp verify token | 自己自訂 | `WHATSAPP_VERIFY_TOKEN`（Cloud） |
| WhatsApp 登入 QR | 系統產生，手機 WhatsApp「連結裝置」掃描 | （Web 模式，自動） |
| WhatsApp session | 存於 Session 儲存目錄 | `WHATSAPP_WEB_AUTH_PATH`（Web） |
| WhatsApp 目標號碼 | 收件者測試清單 / 使用者號碼（E.164） | 目標對照 |
| Teams Microsoft App ID | Entra 應用程式註冊 → 應用程式（用戶端）識別碼 | `TEAMS_APP_ID` |
| Teams Client Secret | Entra 應用程式 → 憑證與密碼 → 新增用戶端密碼 | `TEAMS_APP_PASSWORD` |
| Teams Tenant ID | Entra 應用程式 → 目錄（租用戶）識別碼 | `TEAMS_TENANT_ID` |
| Teams 訊息端點 | Azure Bot → 設定 → 訊息端點 | `https://你的網域/teams/messages` |
| Teams 目標 conversation id | 收到訊息後自動記住（或手填 `19:xxx@thread.v2` / `a:xxx`） | 目標對照 |
| Discord Bot Token | Developer Portal → Bot → Reset Token | `DISCORD_BOT_TOKEN` |
| Discord 目標頻道 ID | Discord 開發者模式 → 對頻道右鍵複製 | 目標對照（`名稱=123456789012345678`） |
