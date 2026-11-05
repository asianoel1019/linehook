# 跨專案通知閘道・速查（One Page）

完整說明見 [`integration.md`](integration.md)。這頁是給「已經知道要做什麼、只想照著貼」的人。

---

## ① 建立 hook（一次）

```bash
curl -X POST https://你的主機/hooks \
  -H 'Authorization: Bearer <admin API Token>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"ci-failed","to":"工作群","platform":"line",
       "template":"{{repo}} #{{pr}} ❌ {{reason}}",
       "include":["failed"],"secret":"<自己產生的長隨機字串>"}'
```

`name` 小寫字母/數字/`-`/`_`；`to` 用**對話名稱**（不要用 id）；`platform` 預設 `line`。

---

## ② 呼叫

```bash
BODY='{"repo":"proj/api","pr":4213,"reason":"3 tests failed"}'
TS=$(date +%s); NONCE=$(uuidgen)
SIG=$(printf '%s' "$TS.$NONCE.$BODY" | openssl dgst -sha256 -hmac '<secret>' -hex | awk '{print $2}')

curl -X POST https://你的主機/hook/ci-failed \
  -H 'Content-Type: application/json' \
  -H "X-Hook-Timestamp: $TS" \
  -H "X-Hook-Nonce: $NONCE" \
  -H "X-Hook-Signature: $SIG" \
  -H 'Idempotency-Key: build-4213' \
  -d "$BODY"
```

**簽章**：`hex(HMAC-SHA256("{timestamp}.{nonce}.{原始 body}", secret))`
**三個必守**：簽原始 body 位元組（別先 parse 再 serialize）、hex 小寫、nonce 每次都換新的。

---

## ③ 現成範例

**GitHub Actions**
```yaml
- name: notify
  if: failure()
  run: |
    TS=$(date +%s); NONCE=$(uuidgen)
    BODY=$(printf '{"repo":"%s","pr":"%s","reason":"CI failed"}' "${{ github.repository }}" "${{ github.event.number }}")
    SIG=$(printf '%s' "$TS.$NONCE.$BODY" | openssl dgst -sha256 -hmac '${{ secrets.HOOK_SECRET }}' -hex | awk '{print $2}')
    curl -s -X POST "$HOOK_URL" -H 'Content-Type: application/json' \
      -H "X-Hook-Timestamp: $TS" -H "X-Hook-Nonce: $NONCE" -H "X-Hook-Signature: $SIG" \
      -H "Idempotency-Key: ${{ github.run_id }}" -d "$BODY"
```

**Node.js**
```js
import crypto from "node:crypto";
const raw = JSON.stringify({ repo, pr, reason });
const ts = String(Math.floor(Date.now() / 1000));
const nonce = crypto.randomUUID();
const sig = crypto.createHmac("sha256", SECRET).update(`${ts}.${nonce}.${raw}`).digest("hex");
await fetch(`${HOOK_URL}/hook/ci-failed`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Hook-Timestamp": ts, "X-Hook-Nonce": nonce, "X-Hook-Signature": sig },
  body: raw,
});
```

**Python**
```python
import hmac, hashlib, json, time, uuid, urllib.request
raw = json.dumps({"repo": "proj/api", "pr": 4213})
ts, nonce = str(int(time.time())), str(uuid.uuid4())
sig = hmac.new(SECRET.encode(), f"{ts}.{nonce}.{raw}".encode(), hashlib.sha256).hexdigest()
req = urllib.request.Request(HOOK_URL + "/hook/ci-failed", data=raw.encode(), headers={
    "Content-Type": "application/json", "X-Hook-Timestamp": ts, "X-Hook-Nonce": nonce, "X-Hook-Signature": sig})
urllib.request.urlopen(req)
```

---

## ④ 回應與狀態碼

| 碼 | 意思 | 該怎麼辦 |
|---|---|---|
| 200 | 已投遞（`delivered:true`）／被降噪跳過（`skipped:true`）／已排程（`scheduled:true`） | 完成 |
| 202 | 已接受，背景投遞中（`deliveryId`） | 用 `GET /hooks/<name>/deliveries` 查 |
| 400 | 範本渲染後是空的／`runAt` 無效 | 檢查 `template` 與 body |
| 403 | 簽章不對／nonce 重放（重放）／時間戳過期 | 見下方排錯 |
| 404 | 沒有這個 hook | `GET /hooks.json` 看名字 |
| 409 | 這個 hook 被停用 | `POST /hooks` 改 `disabled:false` |
| 429 | 超過 per-hook 速率（預設 30/分） | 呼叫端降頻或調高 `ratePerMin` |
| 502 | 投遞失敗（已重試完） | 看錯誤訊息與死信 |
| 503 | 該平台沒啟用 | 啟用對應平台 |

---

## ⑤ hook 設定欄位

| 欄位 | 預設 | 說明 |
|---|---|---|
| `name` | — | 必填；URL 片段 |
| `to` | — | 必填；對話名稱或 id |
| `platform` | `line` | line/telegram/whatsapp/teams/discord |
| `template` | body.text | 訊息範本 |
| `include` | — | 只有命中這些關鍵字才送 |
| `exclude` | — | 命中就不送（優先於 include） |
| `secret` | — | 這個 hook 的簽章金鑰（強烈建議） |
| `replay` | `true` | 要 timestamp＋nonce；`false`＝只簽 body（不建議） |
| `async` | `false` | `true`＝立刻回 202、背景投遞 |
| `ratePerMin` | 30 | per-hook 速率上限（0＝不限） |
| `retries` | 2 | 失敗重試次數（指數退避） |
| `skill` | — | 觸發的技能 id（事件→技能→推播） |
| `skillArgs` | — | 傳給技能的參數範本 |
| `disabled` | `false` | 暫停投遞但保留設定 |

---

## ⑥ 範本速記

| 寫法 | 結果 |
|---|---|
| `{{repo}}` | 取值 |
| `{{a.b.c}}` | 巢狀取值 |
| `{{x | upper}}` / `{{x | lower}}` | 大小寫 |
| `{{x | truncate:40}}` | 截斷 |
| `{{x | default:（無）}}` | 取不到時的預設值 |

取不到的路徑 → 空字串（不會出現 `undefined`）。

---

## ⑦ 排錯速查

| 症狀 | 原因 | 解法 |
|---|---|---|
| 403「簽章驗證失敗」 | body 被重新序列化過／簽的不是原始位元組 | 用原始字串簽 |
| 403「重放的請求」 | 沿用同一個 nonce | 換新 nonce 重新簽（冪等鍵不變） |
| 403「時間戳記無效或已過期」 | 機器時鐘不同步 | 對時；容許誤差 `HMAC_MAX_SKEW_SEC`（預設 300 秒） |
| 200 但沒收到訊息 | 被 `include`/`exclude` 跳過（回應有 `skipped:true`＋`reason`） | 調整關鍵字 |
| 200 但沒收到訊息 | `to` 的名稱對不到 | `GET /status.json` 或技能頁看對話名稱 |
| 一直 502 | 目標對話不存在／平台沒登入／技能失敗 | 看錯誤訊息、`/deadletter.json`、技能日誌 |
| 429 | 呼叫端推太兇 | 降頻或調高 `ratePerMin` |
| 連續 502 後收到告警 | 連續失敗 3 次已觸發告警 | 修好後成功一次即歸零 |

---

## ⑧ 哪裡看紀錄

| 想看 | 去哪 |
|---|---|
| 這次投遞成不成功 | `GET /hooks/<name>/deliveries`（最近 20 筆，含 pending） |
| 誰投了什麼 | `GET /audit.json`（`hook.deliver`／`hook.failed`／`hook.filtered`／`hook.scheduled`／`hook.skill`） |
| 投遞不出去可以重送 | `GET /deadletter.json` → Console 一鍵重送 |
| 統計／告警 | `GET /metrics`：`hook_deliveries_total{hook,platform,result}`、`hook_auth_failures_total`、`hook_rate_limited_total` |
| 技能跑到哪 | 技能頁 → 該技能卡片的「最近執行」 |

---

## ⑨ 管理 API

| 方法 | 路徑 | 權限 |
|---|---|---|
| `GET` | `/hooks.json` | read |
| `POST` | `/hooks` | admin |
| `DELETE` | `/hooks/:name` | admin |
| `GET` | `/hooks/:name/deliveries` | read |

---

## ⑩ 安全檢查

1. 每個 hook 一把金鑰——某家外洩只影響那個 hook，可單獨撤銷。
2. 別把 **admin** API Token 給外部專案；只要投遞請給 `send` scope 的 Token（走 `/webhook`）或用 hook 簽章。
3. `to` 用名稱（id 換了不改設定）。
4. 開著全域 webhook 驗證（hook 沒設金鑰時會走它；全關時 `/hook/:name` 會回 503 而不是變公開端點）。
