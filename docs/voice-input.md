# 語音輸入說明書（STT）

使用者傳語音 → 機器自動轉成文字 → 照常走技能 → **以文字回覆**。

技能本身完全不用改：會處理文字的技能，自動就會處理語音。

---

## 1. 快速開始（三步）

1. 在 `.env` 加一行：

   ```bash
   STT_PROVIDER=gemini
   ```

   （`gemini` 最省事：不用另外申請 key，直接沿用你既有的全域 LLM 設定。）

2. 重啟服務（`.env` 是啟動時讀取的）：

   ```bash
   pm2 restart line-webhook
   ```

3. 傳一則語音給機器人，確認有回覆。

若你的全域 LLM **沒有**設定過（技能頁 → AI 設定），請先設定，或直接看下面第 4 節選一個供應商。

---

## 2. 運作原理

```
使用者傳語音
   │
   ├─ adapter 收進站音訊（轉成 base64，20MB 上限）
   │    LINE 自帳號：語音貼文 blob → audio/mp4
   │    Telegram ：voice / audio → getFile 下載
   │    Discord  ：語音附件（voice:true）→ 下載
   │
   ├─ dispatch：這則訊息只有音訊、沒有文字 → 呼叫 STT
   │    provider=none → 直接回「語音轉文字失敗…」並跳過
   │
   ├─ 轉錄成功 → 文字加上「（語音）」前綴 → 照常比對觸發詞 → 技能執行 → 文字回覆
   │
   └─ 轉錄失敗 → 回一句可操作的提示，管線不中斷
```

兩個重點：

- **技能看到的 `ctx.args` 就是轉錄出來的文字**（前面有「（語音）」），觸發詞比對完全正常。
- **回覆永遠是文字**——語音回覆在多數平台的體驗反而更差，所以刻意不做。

---

## 3. 平台支援

| 平台 | 進站語音 | 說明 |
|---|---|---|
| LINE 自帳號（selfbot） | ✅ | 語音貼文（m4a） |
| Telegram | ✅ | `voice`（ogg/opus）與 `audio`（mp3/m4a） |
| Discord | ✅ | 語音附件（webm/ogg） |
| LINE 官方（Messaging API） | ❌ | 該模式的 webhook 目前只收文字訊息 |
| WhatsApp | ❌ | 進站媒體本來就沒接（文字訊息正常） |
| Teams | ❌ | 不支援音訊收送 |

> 只有在**該平台有傳進站音訊**時才需要對應設定；其他平台不受影響。

---

## 4. 三種供應商

### 4.1 Gemini（推薦，最省事）

```bash
STT_PROVIDER=gemini
# 可選：覆寫模型／端點／語言
# STT_MODEL=gemini-2.0-flash
# STT_BASE_URL=https://generativelanguage.googleapis.com
# STT_LANGUAGE=zh
```

- **不需要另外申請 key**：沒設 `STT_API_KEY` 時，沿用全域 LLM 的 API key（技能頁 → AI 設定 → 儲存 AI 設定）。
- 音訊以 `inline_data` 直接內嵌給 Gemini，不需要先轉成 wav。
- 模型預設 `gemini-2.0-flash`（支援音訊輸入、速度快、便宜）。

### 4.2 OpenAI 相容（whisper）

```bash
STT_PROVIDER=openai
STT_API_KEY=sk-xxx          # 不填則沿用全域 LLM 的 key
STT_BASE_URL=https://api.openai.com/v1
STT_MODEL=whisper-1
STT_LANGUAGE=zh             # 留空＝讓模型自己判斷
```

- 走 `POST {base}/audio/transcriptions`（multipart），任何 whisper 相容端點都行
  （OpenAI、groq、OpenRouter、vLLM 的 whisper 端點…）。
- **注意**：沿用全域 LLM 的 `baseUrl` 時，若那是 OpenRouter 之類沒有 `/audio/transcriptions`
  的端點，請把 `STT_BASE_URL` 明確設成要用的位址。
- 模型預設 `whisper-1`（**不會**沿用全域 LLM 的模型，那通常不是 whisper 型）。

### 4.3 本機 whisper（不外流、不花錢）

```bash
STT_PROVIDER=local
STT_LOCAL_BIN=/usr/local/bin/whisper-cli
STT_LANGUAGE=zh
STT_TIMEOUT_MS=120000       # 本機較慢可以拉長
```

- 需要主機上裝好 whisper.cpp（`whisper-cli`）。
- 會把音訊寫到暫存目錄、跑完立刻刪除。
- 讀取 CLI 的 stdout；沒有輸出就讀 `<out>.txt`。
- **完全不對外傳音訊**——隱私最好，成本最低；吃主機 CPU。

---

## 5. 環境變數總表

| 變數 | 預設 | 說明 |
|---|---|---|
| `STT_PROVIDER` | `none` | `none`／`openai`／`gemini`／`local` |
| `STT_API_KEY` | 空 | 空＝沿用全域 LLM 的 key |
| `STT_BASE_URL` | 空 | 空＝openai 用 `https://api.openai.com/v1`、gemini 用 Google 端點 |
| `STT_MODEL` | 空 | 空＝`whisper-1`（openai）／`gemini-2.0-flash`（gemini） |
| `STT_LANGUAGE` | 空 | 語言提示（`zh`／`en`…）；空＝自動判斷 |
| `STT_LOCAL_BIN` | 空 | `local` 模式的 whisper CLI 路徑 |
| `STT_TIMEOUT_MS` | `60000` | 單次轉錄逾時（毫秒） |

> 這些變數也可以直接寫在 `settings.json` 以外的地方（任何 `.env` 支援的環境變數來源都行）；
> `.env` 最單純。改完要重啟。

---

## 6. 限制

- **大小**：單則音訊 20MB 上限，超過直接略過附件（會有 log 警告）。
- **長度**：沒有限定，但時間越長越慢、越貴。LINE 語音貼文通常沒問題。
- **逾時**：預設 60 秒（`STT_TIMEOUT_MS`）。逾時算失敗，會回提示訊息。
- **格式**：副檔名由 MIME 推導（mp3／m4a／ogg／opus／wav／webm／flac），不支援的格式會以 `.bin` 送出，
  多數 STT 仍可辨識（靠內容而非副檔名）。
- **語言**：沒有強制中文，`STT_LANGUAGE` 可給提示；中英夾雜建議留空讓模型自己判斷。

---

## 7. 錯誤對照表

使用者會看到的訊息與真正的原因：

| 訊息 | 原因 | 怎麼處理 |
|---|---|---|
| `語音轉文字尚未啟用，請改用文字訊息。` | `STT_PROVIDER=none`，或沒憑證 | 設 provider 與憑證後重啟 |
| `語音轉文字失敗，請改用文字訊息（稍後可再試一次）。` | 有開但這次失敗（憑證錯／逾時／聽不懂） | 看 log 的 `語音轉文字失敗` 拿真正原因 |
| `語音轉文字未啟用（設定 STT_PROVIDER 與對應憑證）` | 同上（log 內） | 同上 |
| `STT 未設定 API key` | 沒設 `STT_API_KEY` 且全域 LLM 也沒 key | 設 key（openai/gemini） |
| `STT HTTP 401/403` | key 不對或沒權限 | 檢查 key |
| `STT HTTP 429` | 打到速率限制 | 稍後再試；或改用本機模式 |
| `STT HTTP 404` | 端點不對 | openai 模式確認 `STT_BASE_URL` 有 `/audio/transcriptions` 的服務 |
| `STT 未回傳文字` | 音訊沒人聲／太吵／格式不認得 | 換一段清楚的語音 |
| `本機 STT 啟動失敗：…` | `STT_LOCAL_BIN` 指向不存在的檔 | 檢查路徑與執行權限 |
| `本機 STT 逾時（60000ms）` | 本機太慢 | 拉長 `STT_TIMEOUT_MS` |

log 裡會有 `語音已轉文字 {"provider":"gemini","ms":1234,"chars":42}`（成功）
或 `語音轉文字失敗 {"error":…}`（失敗）。

---

## 8. 驗證與除錯

1. **看有沒有收到音訊**：log 找 `語音已轉文字` 或 `語音轉文字失敗`。
2. **看有沒有進管線**：Console → 「鏈路追蹤」頁籤，會看到 `voice` 事件（成功／失敗）。
3. **技能有沒有被觸發**：轉錄文字前面帶「（語音）」，所以觸發詞要**說出來**
   （例：「阿寶請幫忙 問 台灣最高的山」）。只說「台灣最高的山」在 mode 之外不會觸發——
   這跟文字訊息的行為一致。
4. **手動測 provider**（不經聊天）：

   ```bash
   # Gemini
   curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=$KEY" \
     -H 'Content-Type: application/json' \
     -d '{"contents":[{"parts":[{"text":"ping"}]}]}' | head -c 200
   ```

---

## 9. 隱私與費用

- **本機模式**（`local`）：音訊完全不出主機，零費用，最推���自用。
- **雲端模式**（openai／gemini）：音訊會送到該供應商，等同把語音內容交給它。
  要控管用量就設 `LLM_BUDGET_TOKENS_PER_CHAT_DAY` 與 `LLM_BUDGET_USD_PER_CHAT_DAY`
  （那是對話級 LLM 用量上限，語音轉錄的費用不在其中，量大時建議直接用本機模式）。
- 轉錄失敗時**不會**把音訊存檔（只有 base64 在記憶體中處理完就丟）。

---

## 10. 常見問題

**Q：語音訊息進來了，但技能沒反應？**
A：確認轉錄文字有包含觸發詞。語音不會自動帶前綴——要像文字一樣說「阿寶請幫忙 問 …」。
進入 AI mode 後則不用說觸發詞。

**Q：可以用同一個 key 做語音嗎？**
A：可以，這就是預設行為（沒設 `STT_API_KEY` 就沿用全域 LLM 的 key）。Gemini 走的是
`generativelanguage.googleapis.com`，跟 OpenAI 的 key 不能混用。

**Q：LINE 官方模式沒語音？**
A：對，該模式的 webhook 只處理文字訊息（`normalizeLineEvent` 只收 `type === "text"`）。
要語音請用自帳號模式，或之後再幫 LINE 官方接上內容下載。

**Q：會不會被當成廣告訊息之類的雜訊？**
A：語音會照常走「指令 → 技能 → 轉發」管線，跟文字完全一樣。

**Q：想讓技能知道這是語音來的？**
A：`ctx.args` 開頭的「（語音）」就是標記。
