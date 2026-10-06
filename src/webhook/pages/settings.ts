/* * IM Webhook頁面模板（由 server.ts 拆出，NEXT2 D1）。 */
import { config } from "../../config.js";
import { tr } from "../../i18n.js";
import { page } from "../shell.js";

export function renderSettingsHtml() {
    const deviceOptions = [
        "DESKTOPWIN",
        "DESKTOPMAC",
        "ANDROID",
        "ANDROIDSECONDARY",
        "IOS",
        "IOSIPAD",
        "WATCHOS",
        "WEAROS",
    ]
        .map((d) => `<option value="${d}">${d}</option>`)
        .join("");
    // 平台專屬設定以資料屬性標記；全域 IM 切換（右上角）改變時由 onPlatformChange 過濾。
    const body = `
<p class="msg" data-i18n="settings_note">設定儲存於 <code>settings.json</code>，修改後立即生效（LINE 裝置名稱需重新登入才生效）；點左側卡片切換設定項目。</p>

<form id="settings-form" class="fn-panel active">
  <fieldset class="fn-panel active" data-fn="security">
    <legend data-i18n="legend_security">安全 / 來源</legend>
    <div id="security-strip" class="msg" style="margin-bottom:8px"></div>
    <div class="field"><label data-i18n="lbl_allowed_ips">允許的來源 IP</label><textarea id="allowedIps" data-i18n-ph="ph_allowed_ips" placeholder="逗號或換行分隔，留空 = 不限制"></textarea></div>
    <div class="auth-box">
    <div class="auth-box-title" data-i18n="lbl_hmac">HMAC 簽章密鑰</div>
    <div class="field"><label data-i18n="lbl_hmac">HMAC 簽章密鑰</label><span style="display:flex;gap:8px"><input id="hmacSecret" type="text" style="flex:1"><button type="button" id="hmac-generate" data-i18n="btn_generate">隨機產生</button></span><div class="hint" data-i18n="hint_hmac">留空 = 不驗證簽章</div></div>
    <div class="field"><label data-i18n="auth_enabled">啟用此驗證方式</label><input id="hmacEnabled" type="checkbox"><div class="hint" data-i18n="hint_auth_enabled">關閉後 HMAC 簽章不再被接受（建議只留一種驗證方式）</div></div>
    <div class="field"><label data-i18n="lbl_skew">時間戳記容許誤差（秒）</label><input id="hmacMaxSkewSec" type="number" min="0"></div>
    </div>
    <div class="auth-box">
    <div class="auth-box-title" data-i18n="lbl_webhook_token">Webhook URL Token</div>
    <div class="field"><label data-i18n="lbl_webhook_token">Webhook URL Token</label><span style="display:flex;gap:8px"><input id="webhookToken" type="text" style="flex:1"><button type="button" id="token-generate" data-i18n="btn_generate">隨機產生</button></span><div class="hint">供無法簽章的來源：網址帶 <code>?token=...</code> 或標頭 <code>X-Webhook-Token</code>；與 HMAC 並存時任一通過即可</div></div>
    <div class="field"><label data-i18n="auth_enabled">啟用此驗證方式</label><input id="webhookTokenEnabled" type="checkbox"><div class="hint" data-i18n="hint_auth_enabled">關閉後 URL Token 不再被接受（建議只留一種驗證方式）</div></div>
    </div>
    <div class="auth-box">
    <div class="auth-box-title" data-i18n="lbl_api_token">API Token（Bearer）</div>
    <div class="field"><label data-i18n="lbl_api_token">API Token（Bearer）</label><span style="display:flex;gap:8px"><input id="apiToken" type="text" style="flex:1"><button type="button" id="api-token-generate" data-i18n="btn_generate">隨機產生</button></span><div class="hint">主 Token（僅發送權限）。呼叫 webhook 時帶 <code>Authorization: Bearer &lt;token&gt;</code>；與 HMAC / URL Token 並存時任一通過即可</div></div>
    <div class="field"><label data-i18n="auth_enabled">啟用此驗證方式</label><input id="apiTokenEnabled" type="checkbox"><div class="hint" data-i18n="hint_auth_enabled">關閉後所有 Bearer Token（含多組）不再被接受（建議只留一種驗證方式）</div></div>
    <div class="field"><label data-i18n="lbl_api_tokens">多組 API Token</label><div id="apiTokens"></div><div class="hint" style="grid-column:1" data-i18n="token_hint_scopes">具名 token，可各自撤銷；與上方 API Token、HMAC、URL Token 任一通過即可</div></div>
    <div class="actions" style="margin:0 0 10px"><button type="button" id="api-token-add" data-i18n="btn_add_api_token">新增 API Token</button></div>
    </div>
    <div class="field"><label data-i18n="lbl_admin_private">僅限私人 IP 存取管理頁面</label><input id="adminPrivateOnly" type="checkbox"><div class="hint">狀態頁 / 儀表板 / 功能頁 / 設定頁 / 訊息 / ReadMe / 登入頁僅允許內網（10.x / 172.16–31.x / 192.168.x / 127.x）存取；webhook 不受影響</div></div>
    <div class="field"><label data-i18n="lbl_rate_window">速率限制視窗（ms）</label><input id="rateLimit-windowMs" type="number" min="1"></div>
    <div class="field"><label data-i18n="lbl_rate_max">每 IP 最大請求數</label><input id="rateLimit-max" type="number" min="1"></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="line" data-im="line">
    <legend data-i18n="legend_line">LINE</legend>
    <div class="field"><label data-i18n="lbl_line_mode">帳號模式</label>
      <span style="display:flex;gap:16px;flex-wrap:wrap">
        <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="radio" name="line-mode" value="personal" id="line-mode-personal" style="width:auto"><span data-i18n="line_mode_personal">個人帳號（selfbot）</span></label>
        <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="radio" name="line-mode" value="official" id="line-mode-official" style="width:auto"><span data-i18n="line_mode_official">官方（Messaging API）</span></label>
      </span>
      <div class="hint" data-i18n="hint_line_mode">兩種模式<strong>擇一啟用</strong>（同一時間只會有一個 LINE 服務，與 WhatsApp 的 Cloud／個人帳號相同）。selfbot 違反 LINE 條款有停權風險；官方版合規但有每月訊息額度與較多限制。<strong>切換後需重啟生效。</strong></div>
    </div>

    <div data-line-mode="personal">
      <div class="field"><label data-i18n="lbl_device">裝置類型</label><select id="line-device">${deviceOptions}</select></div>
      <div class="field"><label data-i18n="lbl_device_name">顯示名稱（systemName）</label><input id="line-deviceName" type="text"></div>
      <div class="field"><label data-i18n="lbl_model_name">機型（modelName）</label><input id="line-modelName" type="text"><div class="hint" data-i18n="hint_relogin_needed">顯示名稱需重新登入才生效</div></div>
      <div class="field"><label data-i18n="lbl_line_storage">Session 儲存目錄</label><input id="line-storagePath" type="text" placeholder="./storage.json"><div class="hint" data-i18n="hint_line_storage">登入憑證（authToken）儲存位置；改完路徑按下方「重新登入」即以新位置重新登入，舊檔不會自動搬移</div></div>
      <div class="field"><label data-i18n="lbl_line_relogin">重新登入</label>
        <span style="display:flex;gap:8px;align-items:center"><button type="button" id="line-relogin">${tr(config.language, "btn_line_relogin")}</button><span id="line-relogin-msg" class="msg"></span></span>
        <div class="hint" data-i18n="hint_line_relogin">會先儲存目前設定再觸發重新登入；掃 QR 或輸入 PIN，狀態與 QR 顯示於 <code>/dashboard</code></div>
      </div>
      <div class="field"><div class="hint" data-i18n="hint_lo_personal_targets">目標對照（名稱=mid）在左側「目標對照」卡片，僅在個人帳號模式顯示。</div></div>
    </div>

    <div data-line-mode="official">
      <div class="field"><label data-i18n="lbl_lo_token">Channel access token</label><input id="lo-channelAccessToken" type="password" placeholder=" long-lived 或短期 token"><div class="hint" data-i18n="hint_lo_token">LINE Developers Console → Messaging API → Channel access token (long-lived) 產生；留空 = 發送回 503</div></div>
      <div class="field"><label data-i18n="lbl_lo_secret">Channel secret</label><input id="lo-channelSecret" type="password" placeholder="••••••••"><div class="hint" data-i18n="hint_lo_secret">Basic settings → Channel secret；<strong>未設定會直接拒絕接收 webhook</strong>（這是該端點唯一的來源驗證）</div></div>
      <div class="field"><label data-i18n="lbl_lo_webhook">Webhook URL（自動註冊）</label><input id="lo-webhookUrl" type="text" placeholder="https://example.com/line-official/webhook"><div class="hint" data-i18n="hint_lo_webhook">設定後重啟會以 <code>PUT /v2/bot/channel/webhook/endpoint</code> 自動註冊；也可到 Console 手動填 <code>https://&lt;你的網域&gt;/line-official/webhook</code></div></div>
      <div class="field"><label data-i18n="lbl_lo_targets">目標對照（名稱=userId／groupId）</label><textarea id="lo-targets" placeholder="每行一筆，例如：我=U1234abcd…32hex"></textarea><div class="hint" data-i18n="hint_lo_targets">每行一筆；用戶 <code>U…</code>、群組 <code>c…</code>、多人房 <code>Ra…</code>。收到訊息後會自動記住，可不填</div></div>
      <div class="field"><div class="hint" data-i18n="hint_lo_media">本機檔案要送給 LINE 需先變成<strong>公開連結</strong>（LINE 只收 HTTPS URL）：請在 <code>.env</code> 設定 <code>MEDIA_PUBLIC_URL=https://&lt;你的網域&gt;</code>，檔案會以 HMAC 簽章＋24 小時時效的路徑（<code>/media/…</code>）提供。</div></div>
      <div class="field"><div class="hint" data-i18n="hint_lo_quota">配額：回覆（reply）<strong>不佔</strong>每月訊息額度，push／multicast／broadcast 佔。系統會在 1 分鐘內的回覆自動改用 replyToken，逾時才退回 push。</div></div>
    </div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="telegram" data-im="telegram">
    <legend data-i18n="legend_telegram">Telegram Bot</legend>
    <div class="field"><label data-i18n="lbl_tg_enabled">啟用 Telegram Bot</label><input id="tg-enabled" type="checkbox"><div class="hint">與 LINE 可同時上線；停用後 <code>/webhook/tg</code>、<code>/tg/update</code> 回 503</div></div>
    <div class="field"><label data-i18n="lbl_tg_bot_token">Bot Token</label><input id="tg-botToken" type="text" placeholder="123456:ABC-DEF..."><div class="hint" data-i18n="hint_tg_bot_token">向 @BotFather 申請；留空 = 停用 Telegram</div></div>
    <div class="field"><label data-i18n="lbl_tg_secret">Webhook Secret Token</label><span style="display:flex;gap:8px"><input id="tg-secretToken" type="text" style="flex:1"><button type="button" id="tg-secret-generate" data-i18n="btn_generate">隨機產生</button></span><div class="hint" data-i18n="hint_tg_secret">設定後 Telegram 會以此密鑰傳送 update（X-Telegram-Bot-Api-Secret-Token），建議設定</div></div>
    <div class="field"><label data-i18n="lbl_tg_webhook">Webhook URL</label><input id="tg-webhookUrl" type="text" placeholder="https://example.com/tg/update"><div class="hint" data-i18n="hint_tg_webhook">對外可存取的網址，結尾固定為 /tg/update；設定後重啟會自動註冊</div></div>
    <div class="field"><label data-i18n="lbl_tg_targets">目標對照（名稱=chat_id）</label><textarea id="tg-targets" placeholder="每行一筆，例如：我的群組=-1001234567890"></textarea><div class="hint" data-i18n="hint_tg_targets">每行一筆；也可填 @username</div></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="whatsapp" data-im="whatsapp">
    <legend data-i18n="legend_whatsapp">WhatsApp</legend>
    <div class="field"><label data-i18n="lbl_wa_enabled">啟用 WhatsApp</label><input id="wa-enabled" type="checkbox"><div class="hint">與 LINE / Telegram 可同時上線；停用後 <code>/webhook/wa</code> 回 503</div></div>
    <div class="field"><label data-i18n="lbl_wa_mode">模式</label>
      <span style="display:flex;gap:16px;flex-wrap:wrap">
        <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="radio" name="wa-mode" value="cloud" id="wa-mode-cloud" style="width:auto"><span data-i18n="wa_mode_cloud">Cloud API（官方）</span></label>
        <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="radio" name="wa-mode" value="web" id="wa-mode-web" style="width:auto"><span data-i18n="wa_mode_web">個人帳號（WhatsApp Web）</span></label>
      </span>
      <div class="hint" data-i18n="hint_wa_mode">Cloud API 需 Meta Business 帳號與專用號碼；個人帳號模式以 QR 登入，違反 WhatsApp ToS 有停權風險</div>
    </div>

    <div data-wa-mode="cloud">
      <div class="field"><label data-i18n="lbl_wa_phone_id">Phone Number ID</label><input id="wa-phoneNumberId" type="text" placeholder="123456789012345"><div class="hint" data-i18n="hint_wa_phone_id">Meta 應用中的 WhatsApp 電話號碼 ID（數字）</div></div>
      <div class="field"><label data-i18n="lbl_wa_token">Access Token</label><input id="wa-accessToken" type="text" placeholder="EAA..."><div class="hint" data-i18n="hint_wa_token">Meta 永久或臨時權杖（Bearer）；留空 = 停用 WhatsApp</div></div>
      <div class="field"><label data-i18n="lbl_wa_verify">Webhook Verify Token</label><input id="wa-verifyToken" type="text"><div class="hint" data-i18n="hint_wa_verify">Meta Webhook 設定時自訂的驗證字串（GET 訂閱驗證用），建議設定</div></div>
      <div class="field"><label data-i18n="lbl_wa_secret">App Secret</label><input id="wa-appSecret" type="text"><div class="hint" data-i18n="hint_wa_secret">Meta 應用密鑰，用於驗證 X-Hub-Signature-256；留空 = 不驗簽章（不建議）</div></div>
      <div class="field"><label data-i18n="lbl_wa_version">Graph API 版本</label><input id="wa-apiVersion" type="text" placeholder="v21.0"><div class="hint" data-i18n="hint_wa_version">預設 v21.0；Meta 若升版可於此調整</div></div>
    </div>

    <div data-wa-mode="web">
      <div class="field"><label data-i18n="lbl_wa_web_auth">Session 儲存目錄</label><input id="wa-webAuthPath" type="text" placeholder="./data/whatsapp-web"><div class="hint" data-i18n="hint_wa_web_auth">登入憑證（多檔案）儲存位置；刪除此目錄 = 登出並重新掃 QR</div></div>
      <div class="field"><div class="hint" data-i18n="hint_wa_web_login">儲存並重啟後，至 <code>/dashboard</code>（切到 WhatsApp）掃描 QR 完成登入</div></div>
    </div>

    <div class="field"><label data-i18n="lbl_wa_targets">目標對照（名稱=電話號碼）</label><textarea id="wa-targets" placeholder="每行一筆，例如：小明=886912345678"></textarea><div class="hint" data-i18n="hint_wa_targets">每行一筆，E.164 不含 +</div></div>
    <div class="field" data-wa-mode="cloud"><div class="hint" data-i18n="hint_wa_window">注意：WhatsApp 有 24 小時視窗，主動推播（排程 / 到價通知）可能需改用預審模板</div></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="teams" data-im="teams">
    <legend data-i18n="legend_teams">Microsoft Teams</legend>
    <div class="field"><label data-i18n="lbl_teams_enabled">啟用 Teams</label><input id="teams-enabled" type="checkbox"><div class="hint">與其他平台可同時上線；停用後 <code>/webhook/teams</code>、<code>/teams/messages</code> 回 503</div></div>
    <div class="field"><label data-i18n="lbl_teams_app_id">Microsoft App ID</label><input id="teams-appId" type="text" placeholder="00000000-0000-0000-0000-000000000000"><div class="hint" data-i18n="hint_teams_app_id">Azure Bot 的 Microsoft App ID（Entra 應用程式用戶端識別碼）</div></div>
    <div class="field"><label data-i18n="lbl_teams_app_password">Client Secret</label><input id="teams-appPassword" type="password" placeholder="••••••••"><div class="hint" data-i18n="hint_teams_app_password">Entra 應用程式的用戶端密碼；遺失需重建。留空 = 停用 Teams</div></div>
    <div class="field"><label data-i18n="lbl_teams_tenant_id">Tenant ID</label><input id="teams-tenantId" type="text" placeholder="00000000-0000-0000-0000-000000000000"><div class="hint" data-i18n="hint_teams_tenant_id">Microsoft Entra 租用戶識別碼（single-tenant 就用這個）</div></div>
    <div class="field"><label data-i18n="lbl_teams_service_url">Service URL</label><input id="teams-serviceUrl" type="text" placeholder="https://smba.trafficmanager.net/teams"><div class="hint" data-i18n="hint_teams_service_url">Bot Connector 服務端點，通常用預設即可；首次收訊後會自動記憶實際值，主動推播建議先讓 Bot 收到一次訊息</div></div>
    <div class="field"><label data-i18n="lbl_teams_targets">目標對照（名稱=conversation id）</label><textarea id="teams-targets" placeholder="每行一筆，例如：客服頻道=19:abc@thread.v2"></textarea><div class="hint" data-i18n="hint_teams_targets">每行一筆；收到訊息後系統會自動記住對話，無需手填</div></div>
    <div class="field"><div class="hint">Adaptive Card 卡片可在 Teams 直接呈現（非降級）。接收端點 <code>POST /teams/messages</code> 會以微軟公開金鑰驗證 Bearer JWT。</div></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="discord" data-im="discord">
    <legend data-i18n="legend_discord">Discord</legend>
    <div class="field"><label data-i18n="lbl_dis_enabled">啟用 Discord Bot</label><input id="dis-enabled" type="checkbox"><div class="hint">與其他平台可同時上線；收訊走 Gateway 長連線（無 webhook 端點），停用後需重啟</div></div>
    <div class="field"><label data-i18n="lbl_dis_bot_token">Bot Token</label><input id="dis-botToken" type="password" placeholder="••••••••"><div class="hint" data-i18n="hint_dis_bot_token">Developer Portal → Bot → Reset Token 取得；需於 Bot 設定開啟 MESSAGE_CONTENT Intent</div></div>
    <div class="field"><label data-i18n="lbl_dis_targets">目標對照（名稱=頻道 ID）</label><textarea id="dis-targets" placeholder="每行一筆，例如：客服=123456789012345678"></textarea><div class="hint" data-i18n="hint_dis_targets">每行一筆；頻道/用戶 ID 為 17–20 碼數字（開發者模式右鍵可複製）</div></div>
    <div class="field"><div class="hint" data-i18n="hint_dis_note">文字/圖片/檔案/影片/語音為原生；貼圖、位置、Flex 會降級（見 /console 能力提示）。發送端點 <code>POST /webhook/discord</code>。</div></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="send">
    <legend data-i18n="legend_send">發送 / 重試</legend>
    <div class="field"><label data-i18n="lbl_max_retries">最大重試次數</label><input id="send-maxRetries" type="number" min="0"></div>
    <div class="field"><label data-i18n="lbl_retry_base">重試退避基準（ms）</label><input id="send-retryBaseMs" type="number" min="1"></div>
    <div class="field"><label data-i18n="lbl_min_interval">最小發送間隔（ms）</label><input id="send-minIntervalMs" type="number" min="0"></div>
    <div class="field"><label data-i18n="lbl_reply_max">回覆文字上限（字元）</label><input id="replyMaxChars" type="number" min="0"><div class="hint" data-i18n="hint_reply_max">超過會自動分段送出；0 = 不限制</div></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="monitor">
    <legend data-i18n="legend_monitor">監控 / Log</legend>
    <div class="field"><label data-i18n="lbl_timezone">時區</label><input id="timezone" type="text" placeholder="Asia/Taipei"><div class="hint" data-i18n="hint_timezone">IANA 時區名稱（例如 Asia/Taipei、UTC），影響 log 時間與技能（如「今天」的判斷）</div></div>
    <div class="field"><label data-i18n="lbl_health_interval">健康檢查間隔（秒）</label><input id="healthCheckIntervalSec" type="number" min="1"></div>
    <div class="field"><label data-i18n="lbl_log_limit">記憶體保留紀錄筆數</label><input id="logLimit" type="number" min="1"></div>
    <div class="field"><label data-i18n="lbl_log_max_bytes">Log 輪替大小（bytes）</label><input id="logMaxBytes" type="number" min="1"></div>
    <div class="field"><label data-i18n="lbl_log_max_files">Log 保留檔數</label><input id="logMaxFiles" type="number" min="1"></div>
    <div class="field"><label data-i18n="lbl_messages_persist">持久化收到的訊息</label><input id="messagesPersist" type="checkbox"><div class="hint">開啟後將收到的訊息寫入檔案（路徑：<code>${config.messagesPath}</code>，於 .env 設定）</div></div>
    <div class="field"><div class="hint" data-i18n="hint_alert_section">告警（C2）：平台失效、死信積壓會送至此處設定的通道；各通道獨立送出，單一失敗不影響其他通道。</div></div>
    <div class="field"><label data-i18n="lbl_alert_webhooks">告警 Webhook（每行一筆）</label><textarea id="alert-webhookUrls" placeholder="https://hooks.slack.com/services/… 或 Discord webhook URL"></textarea><div class="hint" data-i18n="hint_alert_webhooks">Email（SMTP）以外的告警通道；同一份 JSON 相容 Slack / Discord / ntfy。兩者都沒設 = 告警只寫 log（視為設定缺失）</div></div>
    <div class="field"><label data-i18n="lbl_alert_deadman">dead-man ping URL</label><input id="alert-deadmanUrl" type="text" placeholder="https://hc-ping.com/your-uuid"><div class="hint" data-i18n="hint_alert_deadman">每輪健康檢查打一次；程序掛掉就不會 ping，由外部 uptime 服務（healthchecks.io 等）在逾時後告警。留空 = 關閉</div></div>
    <div class="field"><label data-i18n="lbl_alert_deadletter">死信告警閾值（筆）</label><input id="alert-deadletterThreshold" type="number" min="0"><div class="hint" data-i18n="hint_alert_deadletter">死信累積超過此數即告警；0 = 關閉</div></div>
    <div class="field"><label data-i18n="lbl_alert_resend">告警重發間隔（分鐘）</label><input id="alert-resendMinutes" type="number" min="1"><div class="hint" data-i18n="hint_alert_resend">同一事由的最短重發間隔（首次立即，之後每 N 分鐘）；恢復時另發「已恢復」通知</div></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="targets-config" data-im="line" data-line-mode="personal">
    <legend data-i18n="legend_targets">目標對照（TARGETS）</legend>
    <div class="field"><label data-i18n="lbl_name_mid">名稱=mid</label><textarea id="targets" placeholder="每行一筆，例如：小明=u1234567890abcdef"></textarea></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="templates">
    <legend data-i18n="legend_templates">訊息模板（Templates）</legend>
    <div class="hint" style="margin-bottom:8px">webhook 帶 <code>template</code> 名稱與 <code>vars</code> 變數即可套用；模板內用 <code>{{key}}</code> 取用變數，未提供的變數會原樣保留。</div>
    <div id="templates"></div>
    <div class="actions"><button type="button" id="template-add" data-i18n="lbl_btn_add_template">新增模板</button></div>
    <div data-im="line">
    <div class="hint" style="margin:14px 0 8px">Flex 樣板（僅 LINE）：webhook 帶 <code>flexTemplate</code> 名稱即可套用；<code>contents</code> 為 Flex 容器 JSON（可用 <code>{{key}}</code> 變數）。</div>
    <div id="flexTemplates"></div>
    <div class="actions"><button type="button" id="flex-template-add" data-i18n="lbl_btn_add_flex">新增 Flex 樣板</button></div>
    </div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="forward">
    <legend data-i18n="legend_forward">訊息轉發規則</legend>
    <div class="hint" style="margin-bottom:8px">收到訊息且符合條件時，自動轉發到指定的好友 / 群組（填入名稱或 mid）。</div>
    <div id="forwardRules"></div>
    <div class="actions"><button type="button" id="forward-add" data-i18n="btn_add_forward">新增轉發規則</button></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="commands">
    <legend data-i18n="legend_commands">指令</legend>
    <div class="field"><label data-i18n="lbl_commands_enabled">啟用指令</label><input id="commands-enabled" type="checkbox"><div class="hint">允許在對話中對本帳號傳送指令（例如 <code>!help</code>）；LINE 與 Telegram 皆適用</div></div>
    <div class="field"><label data-i18n="lbl_commands_prefix">指令前綴</label><input id="commands-prefix" type="text" placeholder="!"><div class="hint">預設 <code>!</code></div></div>
    <div class="field"><label data-i18n="lbl_commands_allow">允許來源</label><textarea id="commands-allowFrom" data-i18n-ph="ph_commands_allow" placeholder="留空 = 所有人；每行一個 mid 或 chat mid"></textarea><div class="hint">可用 <code>!id</code> 取得自己的 mid / chat_id；建議限制來源避免被濫用</div></div>
    <div class="hint">可用指令：<code>help</code>、<code>status</code>、<code>id</code>、<code>send &lt;對象&gt; &lt;訊息&gt;</code></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="smtp">
    <legend data-i18n="legend_smtp">Email 通知（SMTP）</legend>
    <div class="field"><label>SMTP Host</label><input id="smtp-host" type="text"></div>
    <div class="field"><label>SMTP Port</label><input id="smtp-port" type="number" min="1"></div>
    <div class="field"><label>SMTP Secure</label><input id="smtp-secure" type="checkbox"></div>
    <div class="field"><label>SMTP User</label><input id="smtp-user" type="text"></div>
    <div class="field"><label>SMTP Password</label><input id="smtp-pass" type="password"></div>
    <div class="field"><label data-i18n="lbl_smtp_from">寄件者（From）</label><input id="smtp-from" type="text"></div>
    <div class="field"><label data-i18n="lbl_smtp_to">收件者（To）</label><input id="smtp-to" type="text"></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="backup">
    <legend data-i18n="legend_backup">設定匯出 / 匯入</legend>
    <div class="hint" style="margin-bottom:8px">匯出時可設定一組密碼，將整份設定（含所有密鑰）以 AES-256-GCM 加密；匯入時需輸入同一密碼。留空密碼則匯出明文（不建議）。匯入會覆蓋目前設定。</div>
    <div class="actions">
      <button type="button" id="settings-export" data-i18n="btn_export">匯出設定</button>
      <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer"><span data-i18n="btn_import">匯入設定</span><input id="settings-import-file" type="file" accept="application/json,.json" style="display:none"></label>
    </div>
    <div class="hint" style="margin:14px 0 8px">完整備份（含設定、登入狀態、排程檔，一律加密；還原前會自動備份現況）。</div>
    <div class="actions">
      <button type="button" id="settings-backup">備份下載</button>
      <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer"><span>還原備份</span><input id="settings-backup-file" type="file" accept="application/json,.json" style="display:none"></label>
      <span id="backup-msg" class="msg"></span>
    </div>
  </fieldset>

  <div class="actions">
    <button type="submit" data-i18n="save_settings">儲存設定</button>
    <span id="settings-msg" class="msg"></span>
  </div>
</form>
`;
    const script = `
  var CONFIG_SECTIONS = ["security", "line", "telegram", "whatsapp", "teams", "discord", "send", "monitor", "targets-config", "templates", "forward", "commands", "smtp", "backup"];

  // LINE 兩種帳號模式擇一（仿 WhatsApp）：帶 data-line-mode 的區塊依模式顯示／隱藏。
  var currentLineMode = "personal";

  function applySettingsPlatform(platform, jump) {
    Array.prototype.forEach.call(document.querySelectorAll("[data-im],[data-line-mode]"), function (el) {
      var imOk = !el.hasAttribute("data-im") || el.getAttribute("data-im") === platform;
      var modeOk = !el.hasAttribute("data-line-mode") || el.getAttribute("data-line-mode") === currentLineMode;
      el.classList.toggle("plat-off", !(imOk && modeOk));
    });
    if (jump) showSection(platform, CONFIG_SECTIONS);
  }

  function readLineMode() {
    var official = $("line-mode-official");
    return official && official.checked ? "official" : "personal";
  }

  window.onPlatformChange = function (platform) {
    applySettingsPlatform(platform, true);
  };
  applySettingsPlatform(window.LW_PLATFORM || "line", false);
  Array.prototype.forEach.call(document.querySelectorAll("input[name=line-mode]"), function (radio) {
    radio.addEventListener("change", function () {
      currentLineMode = readLineMode();
      applySettingsPlatform(window.LW_PLATFORM || "line", false);
    });
  });

  function addForwardRow(rule) {
    rule = rule || {};
    var row = document.createElement("div");
    row.className = "forward-row";
    row.style.cssText = "border:1px solid rgba(244,114,182,.25);border-radius:12px;padding:10px 14px;margin-bottom:10px;background:rgba(0,0,0,.2)";

    function field(labelText, input) {
      var wrap = document.createElement("div");
      wrap.className = "field";
      var label = document.createElement("label");
      label.textContent = labelText;
      wrap.append(label, input);
      return wrap;
    }
    function textInput(cls, value, placeholder) {
      var input = document.createElement("input");
      input.className = cls;
      input.type = "text";
      input.value = value || "";
      if (placeholder) input.placeholder = placeholder;
      return input;
    }

    var match = document.createElement("select");
    match.className = "f-match";
    [["contains", "match_contains"], ["regex", "match_regex"], ["all", "match_all"]].forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt[0];
      o.textContent = T(opt[1]);
      if ((rule.match || "contains") === opt[0]) o.selected = true;
      match.appendChild(o);
    });
    var keyword = textInput("f-keyword", rule.keyword, T("lbl_keyword"));
    var source = textInput("f-source", rule.source, T("lbl_source"));
    var target = textInput("f-target", rule.target, T("lbl_forward_target"));
    var prefix = textInput("f-prefix", rule.prefix, T("lbl_prefix"));
    var includeSender = document.createElement("input");
    includeSender.type = "checkbox";
    includeSender.className = "f-includeSender";
    includeSender.checked = !!rule.includeSender;
    var enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "f-enabled";
    enabled.checked = rule.enabled !== false;

    row.append(field(T("lbl_match_type"), match));
    row.append(field(T("lbl_keyword"), keyword));
    row.append(field(T("lbl_source"), source));
    row.append(field(T("lbl_forward_target"), target));
    row.append(field(T("lbl_prefix"), prefix));
    row.append(field(T("lbl_include_sender"), includeSender));
    row.append(field(T("lbl_enabled"), enabled));

    var actions = document.createElement("div");
    actions.className = "actions";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = T("btn_delete_rule");
    remove.addEventListener("click", function () { row.remove(); });
    actions.appendChild(remove);
    row.appendChild(actions);

    $("forwardRules").appendChild(row);
  }

  function collectForwardRules() {
    var out = [];
    var rows = $("forwardRules").querySelectorAll(".forward-row");
    Array.prototype.forEach.call(rows, function (row) {
      out.push({
        id: row.getAttribute("data-id") || "",
        enabled: row.querySelector(".f-enabled").checked,
        match: row.querySelector(".f-match").value,
        keyword: row.querySelector(".f-keyword").value,
        source: row.querySelector(".f-source").value.trim(),
        target: row.querySelector(".f-target").value.trim(),
        includeSender: row.querySelector(".f-includeSender").checked,
        prefix: row.querySelector(".f-prefix").value
      });
    });
    return out;
  }

  function addApiTokenRow(item) {
    item = item || {};
    var scopes = Array.isArray(item.scopes) ? item.scopes : ["send"];
    var row = document.createElement("div");
    row.className = "api-token-row";
    row.style.cssText = "display:flex;gap:8px;margin-bottom:8px;grid-column:2;flex-wrap:wrap;align-items:center";
    var name = document.createElement("input");
    name.type = "text";
    name.className = "at-name";
    name.value = item.name || "";
    name.placeholder = T("lbl_name");
    name.style.flex = "0 0 120px";
    var token = document.createElement("input");
    token.type = "text";
    token.className = "at-token";
    token.value = item.token || "";
    token.placeholder = "token";
    token.style.flex = "1";
    var gen = document.createElement("button");
    gen.type = "button";
    gen.textContent = T("btn_generate");
    gen.addEventListener("click", function () { token.value = randomHex(32); });
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = T("btn_delete");
    remove.addEventListener("click", function () { row.remove(); });
    row.append(name, token, gen, remove);
    var scopeWrap = document.createElement("span");
    scopeWrap.style.cssText = "display:flex;gap:10px;align-items:center;flex:1 1 100%;font-size:13px;color:#94a3b8";
    var scopeLabel = document.createElement("span");
    scopeLabel.textContent = T("lbl_scope") + "：";
    scopeWrap.appendChild(scopeLabel);
    ["read", "send", "admin"].forEach(function (s) {
      var label = document.createElement("label");
      label.style.cssText = "display:flex;gap:4px;align-items:center;cursor:pointer";
      var box = document.createElement("input");
      box.type = "checkbox";
      box.className = "at-scope";
      box.value = s;
      box.checked = scopes.indexOf(s) !== -1;
      label.append(box, document.createTextNode(T("scope_" + s)));
      scopeWrap.appendChild(label);
    });
    var usage = document.createElement("span");
    usage.className = "at-usage msg";
    usage.style.marginLeft = "auto";
    scopeWrap.appendChild(usage);
    row.appendChild(scopeWrap);
    $("apiTokens").appendChild(row);
  }

  function collectApiTokens() {
    var out = [];
    var rows = $("apiTokens").querySelectorAll(".api-token-row");
    Array.prototype.forEach.call(rows, function (row) {
      var scopes = [];
      Array.prototype.forEach.call(row.querySelectorAll(".at-scope:checked"), function (box) {
        scopes.push(box.value);
      });
      out.push({
        name: row.querySelector(".at-name").value.trim(),
        token: row.querySelector(".at-token").value.trim(),
        scopes: scopes
      });
    });
    return out.filter(function (item) { return item.token; });
  }

  function refreshTokenUsage() {
    fetch("/tokens/usage.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        var byName = {};
        ((data && data.usage) || []).forEach(function (u) { byName[u.name] = u; });
        Array.prototype.forEach.call($("apiTokens").querySelectorAll(".api-token-row"), function (row) {
          var el = row.querySelector(".at-usage");
          if (!el) return;
          var u = byName[row.querySelector(".at-name").value.trim()];
          if (!u || !u.count) { el.textContent = T("token_never_used"); return; }
          var last = u.lastUsedAt ? u.lastUsedAt.slice(0, 16).replace("T", " ") : "";
          el.textContent = T("token_used") + " " + u.count + T("token_times") + (last ? " · " + T("token_last") + " " + last : "");
        });
      })
      .catch(function () {});
  }

  function addTemplateRow(tpl) {
    tpl = tpl || {};
    var row = document.createElement("div");
    row.className = "template-row";
    row.style.cssText = "border:1px solid rgba(34,211,238,.25);border-radius:12px;padding:10px 14px;margin-bottom:10px;background:rgba(0,0,0,.2)";

    function field(labelText, input) {
      var wrap = document.createElement("div");
      wrap.className = "field";
      var label = document.createElement("label");
      label.textContent = labelText;
      wrap.append(label, input);
      return wrap;
    }

    var name = document.createElement("input");
    name.type = "text";
    name.className = "t-name";
    name.value = tpl.name || "";
    name.placeholder = T("lbl_name");

    var text = document.createElement("textarea");
    text.className = "t-text";
    text.value = tpl.text || "";
    text.placeholder = T("lbl_content");

    row.append(field(T("lbl_name"), name));
    row.append(field(T("lbl_content"), text));

    var actions = document.createElement("div");
    actions.className = "actions";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = T("btn_delete_template");
    remove.addEventListener("click", function () { row.remove(); });
    actions.appendChild(remove);
    row.appendChild(actions);

    $("templates").appendChild(row);
  }

  function collectTemplates() {
    var out = [];
    var rows = $("templates").querySelectorAll(".template-row");
    Array.prototype.forEach.call(rows, function (row) {
      out.push({
        name: row.querySelector(".t-name").value.trim(),
        text: row.querySelector(".t-text").value
      });
    });
    return out;
  }

  function addFlexTemplateRow(tpl) {
    tpl = tpl || {};
    var row = document.createElement("div");
    row.className = "flex-template-row";
    row.style.cssText = "border:1px solid rgba(244,114,182,.25);border-radius:12px;padding:10px 14px;margin-bottom:10px;background:rgba(0,0,0,.2)";

    function field(labelText, input) {
      var wrap = document.createElement("div");
      wrap.className = "field";
      var label = document.createElement("label");
      label.textContent = labelText;
      wrap.append(label, input);
      return wrap;
    }

    var name = document.createElement("input");
    name.type = "text";
    name.className = "ft-name";
    name.value = tpl.name || "";
    name.placeholder = T("lbl_name");

    var alt = document.createElement("input");
    alt.type = "text";
    alt.className = "ft-alt";
    alt.value = tpl.altText || "";
    alt.placeholder = T("lbl_alt_text");

    var contents = document.createElement("textarea");
    contents.className = "ft-contents";
    contents.value = tpl.contents || "";
    contents.placeholder = '{"type":"bubble","body":{...}}';

    row.append(field(T("lbl_name"), name));
    row.append(field(T("lbl_alt_text"), alt));
    row.append(field(T("lbl_flex_json"), contents));

    var actions = document.createElement("div");
    actions.className = "actions";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = T("btn_delete_flex");
    remove.addEventListener("click", function () { row.remove(); });
    actions.appendChild(remove);
    row.appendChild(actions);

    $("flexTemplates").appendChild(row);
  }

  function collectFlexTemplates() {
    var out = [];
    var rows = $("flexTemplates").querySelectorAll(".flex-template-row");
    Array.prototype.forEach.call(rows, function (row) {
      out.push({
        name: row.querySelector(".ft-name").value.trim(),
        altText: row.querySelector(".ft-alt").value,
        contents: row.querySelector(".ft-contents").value
      });
    });
    return out;
  }

  function paintSecurityStrip(s) {
    var el = $("security-strip");
    if (!el) return;
    var hasHmac = (s.hmacEnabled !== false) && !!(s.hmacSecret || "");
    var hasApi = (s.apiTokenEnabled !== false) && !!((s.apiToken || "") || ((s.apiTokens || []).some(function (t) { return t && t.token; })));
    var hasToken = (s.webhookTokenEnabled !== false) && !!(s.webhookToken || "");
    if (hasHmac || hasApi) {
      el.style.color = "#34d399";
      el.textContent = "🟢 " + T("security_green");
    } else if (hasToken) {
      el.style.color = "#fbbf24";
      el.textContent = "🟡 " + T("security_yellow");
    } else {
      el.style.color = "#fb7185";
      el.textContent = "🔴 " + T("security_red");
    }
  }

  function fillForm(s) {
    paintSecurityStrip(s);
    $("allowedIps").value = (s.allowedIps || []).join(", ");
    $("hmacSecret").value = s.hmacSecret || "";
    $("hmacEnabled").checked = s.hmacEnabled !== false;
    $("hmacMaxSkewSec").value = s.hmacMaxSkewSec;
    $("webhookToken").value = s.webhookToken || "";
    $("webhookTokenEnabled").checked = s.webhookTokenEnabled !== false;
    $("apiToken").value = s.apiToken || "";
    $("apiTokenEnabled").checked = s.apiTokenEnabled !== false;
    $("adminPrivateOnly").checked = !!s.adminPrivateOnly;
    $("rateLimit-windowMs").value = s.rateLimit.windowMs;
    $("rateLimit-max").value = s.rateLimit.max;
    $("line-device").value = s.line.device;
    $("line-deviceName").value = s.line.deviceName || "";
    $("line-modelName").value = s.line.modelName || "";
    $("line-storagePath").value = (s.line && s.line.storagePath) || "./storage.json";
    var loMode = (s.line && s.line.mode) === "official" ? "official" : "personal";
    $("line-mode-personal").checked = loMode !== "official";
    $("line-mode-official").checked = loMode === "official";
    currentLineMode = loMode;
    $("lo-channelAccessToken").value = (s.line && s.line.official && s.line.official.channelAccessToken) || "";
    $("lo-channelSecret").value = (s.line && s.line.official && s.line.official.channelSecret) || "";
    $("lo-webhookUrl").value = (s.line && s.line.official && s.line.official.webhookUrl) || "";
    $("lo-targets").value = Object.keys((s.line && s.line.official && s.line.official.targets) || {}).map(function (k) { return k + "=" + s.line.official.targets[k]; }).join("\\n");
    applySettingsPlatform(window.LW_PLATFORM || "line", false);
    $("tg-enabled").checked = !!(s.telegram && s.telegram.enabled);
    $("tg-botToken").value = (s.telegram && s.telegram.botToken) || "";
    $("tg-secretToken").value = (s.telegram && s.telegram.secretToken) || "";
    $("tg-webhookUrl").value = (s.telegram && s.telegram.webhookUrl) || "";
    $("tg-targets").value = Object.keys((s.telegram && s.telegram.targets) || {}).map(function (k) { return k + "=" + s.telegram.targets[k]; }).join("\\n");
    $("wa-enabled").checked = !!(s.whatsapp && s.whatsapp.enabled);
    $("wa-phoneNumberId").value = (s.whatsapp && s.whatsapp.phoneNumberId) || "";
    $("wa-accessToken").value = (s.whatsapp && s.whatsapp.accessToken) || "";
    $("wa-verifyToken").value = (s.whatsapp && s.whatsapp.verifyToken) || "";
    $("wa-appSecret").value = (s.whatsapp && s.whatsapp.appSecret) || "";
    $("wa-apiVersion").value = (s.whatsapp && s.whatsapp.apiVersion) || "v21.0";
    $("wa-webAuthPath").value = (s.whatsapp && s.whatsapp.webAuthPath) || "./data/whatsapp-web";
    var waMode = (s.whatsapp && s.whatsapp.mode) === "web" ? "web" : "cloud";
    $("wa-mode-cloud").checked = waMode === "cloud";
    $("wa-mode-web").checked = waMode === "web";
    $("wa-targets").value = Object.keys((s.whatsapp && s.whatsapp.targets) || {}).map(function (k) { return k + "=" + s.whatsapp.targets[k]; }).join("\\n");
    $("teams-enabled").checked = !!(s.teams && s.teams.enabled);
    $("teams-appId").value = (s.teams && s.teams.appId) || "";
    $("teams-appPassword").value = (s.teams && s.teams.appPassword) || "";
    $("teams-tenantId").value = (s.teams && s.teams.tenantId) || "";
    $("teams-serviceUrl").value = (s.teams && s.teams.serviceUrl) || "https://smba.trafficmanager.net/teams";
    $("teams-targets").value = Object.keys((s.teams && s.teams.targets) || {}).map(function (k) { return k + "=" + s.teams.targets[k]; }).join("\\n");
    $("dis-enabled").checked = !!(s.discord && s.discord.enabled);
    $("dis-botToken").value = (s.discord && s.discord.botToken) || "";
    $("dis-targets").value = Object.keys((s.discord && s.discord.targets) || {}).map(function (k) { return k + "=" + s.discord.targets[k]; }).join("\\n");
    $("send-maxRetries").value = s.send.maxRetries;
    $("send-retryBaseMs").value = s.send.retryBaseMs;
    $("send-minIntervalMs").value = s.send.minIntervalMs;
    $("replyMaxChars").value = s.replyMaxChars;
    $("healthCheckIntervalSec").value = s.healthCheckIntervalSec;
    $("logLimit").value = s.logLimit;
    $("logMaxBytes").value = s.logMaxBytes;
    $("logMaxFiles").value = s.logMaxFiles;
    $("messagesPersist").checked = !!s.messagesPersist;
    $("alert-webhookUrls").value = ((s.alert && s.alert.webhookUrls) || []).join("\\n");
    $("alert-deadmanUrl").value = (s.alert && s.alert.deadmanUrl) || "";
    $("alert-deadletterThreshold").value = s.alert && typeof s.alert.deadletterThreshold === "number" ? s.alert.deadletterThreshold : 10;
    $("alert-resendMinutes").value = s.alert && typeof s.alert.resendMinutes === "number" ? s.alert.resendMinutes : 30;
    $("timezone").value = s.timezone || "Asia/Taipei";
    $("targets").value = Object.keys(s.targets || {}).map(function (k) { return k + "=" + s.targets[k]; }).join("\\n");
    $("smtp-host").value = s.smtp.host || "";
    $("smtp-port").value = s.smtp.port;
    $("smtp-secure").checked = !!s.smtp.secure;
    $("smtp-user").value = s.smtp.user || "";
    $("smtp-pass").value = s.smtp.pass || "";
    $("smtp-from").value = s.smtp.from || "";
    $("smtp-to").value = s.smtp.to || "";
    $("templates").replaceChildren();
    (s.templates || []).forEach(addTemplateRow);
    $("flexTemplates").replaceChildren();
    (s.flexTemplates || []).forEach(addFlexTemplateRow);
    $("apiTokens").replaceChildren();
    (s.apiTokens || []).forEach(addApiTokenRow);
    refreshTokenUsage();
    $("forwardRules").replaceChildren();
    (s.forward || []).forEach(addForwardRow);
    $("commands-enabled").checked = !!(s.commands && s.commands.enabled);
    $("commands-prefix").value = (s.commands && s.commands.prefix) || "!";
    $("commands-allowFrom").value = ((s.commands && s.commands.allowFrom) || []).join("\\n");
  }

  function loadForm() {
    fetch("/settings.json", { cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) { window.location.href = "/login"; return null; }
        return res.ok ? res.json() : null;
      })
      .then(function (s) { if (s) fillForm(s); })
      .catch(function () {});
  }

  function collectForm() {
    var targets = {};
    $("targets").value.split(/\\r?\\n/).forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      var i = t.indexOf("=");
      if (i <= 0) return;
      targets[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    });
    var tgTargets = {};
    $("tg-targets").value.split(/\\r?\\n/).forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      var i = t.indexOf("=");
      if (i <= 0) return;
      tgTargets[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    });
    var waTargets = {};
    $("wa-targets").value.split(/\\r?\\n/).forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      var i = t.indexOf("=");
      if (i <= 0) return;
      waTargets[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    });
    var teamsTargets = {};
    $("teams-targets").value.split(/\\r?\\n/).forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      var i = t.indexOf("=");
      if (i <= 0) return;
      teamsTargets[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    });
    var discordTargets = {};
    $("dis-targets").value.split(/\\r?\\n/).forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      var i = t.indexOf("=");
      if (i <= 0) return;
      discordTargets[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    });
    var loTargets = {};
    $("lo-targets").value.split(/\\r?\\n/).forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      var i = t.indexOf("=");
      if (i <= 0) return;
      loTargets[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    });
    return {
      allowedIps: $("allowedIps").value.split(/[\\n,]/).map(function (x) { return x.trim(); }).filter(Boolean),
      hmacSecret: $("hmacSecret").value,
      hmacEnabled: $("hmacEnabled").checked,
      hmacMaxSkewSec: Number($("hmacMaxSkewSec").value),
      webhookToken: $("webhookToken").value,
      webhookTokenEnabled: $("webhookTokenEnabled").checked,
      apiToken: $("apiToken").value,
      apiTokenEnabled: $("apiTokenEnabled").checked,
      apiTokens: collectApiTokens(),
      adminPrivateOnly: $("adminPrivateOnly").checked,
      targets: targets,
      templates: collectTemplates(),
      flexTemplates: collectFlexTemplates(),
      forward: collectForwardRules(),
      healthCheckIntervalSec: Number($("healthCheckIntervalSec").value),
      logLimit: Number($("logLimit").value),
      logMaxBytes: Number($("logMaxBytes").value),
      logMaxFiles: Number($("logMaxFiles").value),
      messagesPersist: $("messagesPersist").checked,
      timezone: $("timezone").value.trim() || "Asia/Taipei",
      send: {
        maxRetries: Number($("send-maxRetries").value),
        retryBaseMs: Number($("send-retryBaseMs").value),
        minIntervalMs: Number($("send-minIntervalMs").value)
      },
      rateLimit: {
        windowMs: Number($("rateLimit-windowMs").value),
        max: Number($("rateLimit-max").value)
      },
      replyMaxChars: Number($("replyMaxChars").value),
      line: {
        mode: readLineMode(),
        storagePath: $("line-storagePath").value.trim() || "./storage.json",
        device: $("line-device").value,
        deviceName: $("line-deviceName").value,
        modelName: $("line-modelName").value,
        official: {
          channelAccessToken: $("lo-channelAccessToken").value.trim(),
          channelSecret: $("lo-channelSecret").value.trim(),
          webhookUrl: $("lo-webhookUrl").value.trim(),
          targets: loTargets
        }
      },
      telegram: {
        enabled: $("tg-enabled").checked,
        botToken: $("tg-botToken").value.trim(),
        secretToken: $("tg-secretToken").value.trim(),
        webhookUrl: $("tg-webhookUrl").value.trim(),
        targets: tgTargets
      },
      whatsapp: {
        enabled: $("wa-enabled").checked,
        mode: $("wa-mode-web").checked ? "web" : "cloud",
        phoneNumberId: $("wa-phoneNumberId").value.trim(),
        accessToken: $("wa-accessToken").value.trim(),
        verifyToken: $("wa-verifyToken").value.trim(),
        appSecret: $("wa-appSecret").value.trim(),
        apiVersion: $("wa-apiVersion").value.trim() || "v21.0",
        webAuthPath: $("wa-webAuthPath").value.trim() || "./data/whatsapp-web",
        targets: waTargets
      },
      teams: {
        enabled: $("teams-enabled").checked,
        appId: $("teams-appId").value.trim(),
        appPassword: $("teams-appPassword").value.trim(),
        tenantId: $("teams-tenantId").value.trim(),
        serviceUrl: $("teams-serviceUrl").value.trim() || "https://smba.trafficmanager.net/teams",
        targets: teamsTargets
      },
      discord: {
        enabled: $("dis-enabled").checked,
        botToken: $("dis-botToken").value.trim(),
        targets: discordTargets
      },
      smtp: {
        host: $("smtp-host").value,
        port: Number($("smtp-port").value),
        secure: $("smtp-secure").checked,
        user: $("smtp-user").value,
        pass: $("smtp-pass").value,
        from: $("smtp-from").value,
        to: $("smtp-to").value
      },
      alert: {
        webhookUrls: $("alert-webhookUrls").value.split(/\\r?\\n/).map(function (x) { return x.trim(); }).filter(Boolean),
        deadmanUrl: $("alert-deadmanUrl").value.trim(),
        deadletterThreshold: Math.max(0, Number($("alert-deadletterThreshold").value) || 0),
        resendMinutes: Math.max(1, Number($("alert-resendMinutes").value) || 30)
      },
      commands: {
        enabled: $("commands-enabled").checked,
        prefix: $("commands-prefix").value || "!",
        allowFrom: $("commands-allowFrom").value.split(/[\\n,]/).map(function (x) { return x.trim(); }).filter(Boolean)
      }
    };
  }

  function randomHex(bytes) {
    var buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return Array.prototype.map.call(buf, function (b) {
      return ("0" + b.toString(16)).slice(-2);
    }).join("");
  }

  $("hmac-generate").addEventListener("click", function () {
    $("hmacSecret").value = randomHex(32);
    $("settings-msg").textContent = "已產生新密鑰，請按「儲存設定」";
  });

  $("token-generate").addEventListener("click", function () {
    $("webhookToken").value = randomHex(32);
    $("settings-msg").textContent = "已產生新 token，請按「儲存設定」";
  });

  $("api-token-generate").addEventListener("click", function () {
    $("apiToken").value = randomHex(32);
    $("settings-msg").textContent = "已產生新 API Token，請按「儲存設定」";
  });

  // LINE 個人帳號重新登入（原在 /console「操作」，改放設定頁）。會先儲存目前設定再觸發，
  // 讓「改 Session 儲存目錄 → 立即以新路徑重登」只需按一次。
  $("line-relogin").addEventListener("click", function () {
    var msg = $("line-relogin-msg");
    msg.textContent = "儲存中…";
    post("settings", collectForm()).then(function (r) {
      if (!r.ok) {
        msg.textContent = "儲存失敗：" + ((r.data && r.data.error) || "");
        return null;
      }
      msg.textContent = "重登中…";
      return post("settings/relogin").then(function (q) {
        msg.textContent = q.ok ? "已觸發重新登入（狀態與 QR 見 /dashboard）" : ("失敗：" + ((q.data && q.data.error) || ""));
      });
    }).catch(function () {
      msg.textContent = "請求失敗";
    });
  });

  $("tg-secret-generate").addEventListener("click", function () {
    $("tg-secretToken").value = randomHex(32);
    $("settings-msg").textContent = "已產生新 Telegram Secret Token，儲存並重啟後生效（會重新 setWebhook）";
  });

  $("template-add").addEventListener("click", function () {
    addTemplateRow({});
  });

  $("flex-template-add").addEventListener("click", function () {
    addFlexTemplateRow({});
  });

  $("api-token-add").addEventListener("click", function () {
    addApiTokenRow({});
  });

  $("forward-add").addEventListener("click", function () {
    addForwardRow({});
  });

  $("settings-export").addEventListener("click", function () {
    var pw = window.prompt("設定匯出密碼（用來加密整份設定，含密鑰；匯入時需同一組）。留空 = 不加密（含明文密鑰，不建議）", "");
    if (pw === null) return;
    var url = "/settings/export";
    if (pw) url += "?password=" + encodeURIComponent(pw);
    window.location.href = url;
  });

  $("settings-backup").addEventListener("click", function () {
    var pw = window.prompt("備份密碼（設定＋登入狀態＋排程檔，一律加密；還原時需同一組）", "");
    if (!pw) { $("backup-msg").textContent = "備份需設定密碼"; return; }
    window.location.href = "/settings/backup?password=" + encodeURIComponent(pw);
  });

  $("settings-backup-file").addEventListener("change", function () {
    var input = $("settings-backup-file");
    if (!input.files || !input.files[0]) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(String(reader.result)); }
      catch (e) { $("backup-msg").textContent = "還原失敗：JSON 格式錯誤"; return; }
      var pw = window.prompt("請輸入備份時的密碼（還原前會自動備份現況）：", "");
      if (pw === null) { input.value = ""; return; }
      post("settings/backup/restore", { bundle: parsed, password: pw }).then(function (r) {
        if (!r.ok) { $("backup-msg").textContent = "還原失敗：" + (r.data.error || ""); return; }
        $("backup-msg").textContent = "已還原（" + (r.data.restored || []).join("、") + "），請重啟服務";
        loadForm();
      });
    };
    reader.readAsText(input.files[0]);
    input.value = "";
  });

  $("settings-import-file").addEventListener("change", function () {
    var input = $("settings-import-file");
    if (!input.files || !input.files[0]) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(String(reader.result)); }
      catch (e) { $("settings-msg").textContent = "匯入失敗：JSON 格式錯誤"; return; }
      var payload = { settings: parsed };
      // 若為加密信封，詢問密碼。
      if (parsed && parsed.enc === "aes-256-gcm") {
        var pw = window.prompt("此設定檔已加密，請輸入匯出時的密碼：", "");
        if (pw === null) { input.value = ""; return; }
        payload.password = pw;
      }
      post("settings/import", payload).then(function (r) {
        if (!r.ok) { $("settings-msg").textContent = "匯入失敗：" + (r.data.error || ""); return; }
        $("settings-msg").textContent = "已匯入設定";
        fillForm(r.data.settings);
      });
    };
    reader.readAsText(input.files[0]);
    input.value = "";
  });

  function applyWaMode() {
    var mode = $("wa-mode-web").checked ? "web" : "cloud";
    Array.prototype.forEach.call(document.querySelectorAll("[data-wa-mode]"), function (el) {
      el.classList.toggle("plat-off", el.getAttribute("data-wa-mode") !== mode);
    });
  }
  $("wa-mode-cloud").addEventListener("change", applyWaMode);
  $("wa-mode-web").addEventListener("change", applyWaMode);

  $("settings-form").addEventListener("submit", function (e) {
    e.preventDefault();
    $("settings-msg").textContent = "儲存中…";
    post("settings", collectForm()).then(function (r) {
      $("settings-msg").textContent = r.ok ? "已儲存" : ("失敗：" + (r.data.error || ""));
    });
  });

  setupCards(CONFIG_SECTIONS, "security");
  loadForm();
  // loadForm 是非同步；等填完再用目前選擇套用 WhatsApp 模式顯示。
  setTimeout(applyWaMode, 300);
`;
    const sidebar = `
<div class="side-section">${tr(config.language, "section_settings")}</div>
<div class="fn-list">
  <button type="button" class="fn-card setting active" data-fn="security">${tr(config.language, "card_security")}</button>
  <button type="button" class="fn-card setting" data-fn="line" data-im="line">${tr(config.language, "card_line")}</button>
  <button type="button" class="fn-card setting" data-fn="telegram" data-im="telegram">${tr(config.language, "card_telegram")}</button>
  <button type="button" class="fn-card setting" data-fn="whatsapp" data-im="whatsapp">${tr(config.language, "card_whatsapp")}</button>
  <button type="button" class="fn-card setting" data-fn="teams" data-im="teams">${tr(config.language, "card_teams")}</button>
  <button type="button" class="fn-card setting" data-fn="discord" data-im="discord">${tr(config.language, "card_discord")}</button>
  <button type="button" class="fn-card setting" data-fn="send">${tr(config.language, "card_send")}</button>
  <button type="button" class="fn-card setting" data-fn="monitor">${tr(config.language, "card_monitor")}</button>
  <button type="button" class="fn-card setting" data-fn="targets-config" data-im="line" data-line-mode="personal">${tr(config.language, "card_targets_config")}</button>
  <button type="button" class="fn-card setting" data-fn="templates">${tr(config.language, "card_templates")}</button>
  <button type="button" class="fn-card setting" data-fn="forward">${tr(config.language, "card_forward")}</button>
  <button type="button" class="fn-card setting" data-fn="commands">${tr(config.language, "card_commands")}</button>
  <button type="button" class="fn-card setting" data-fn="smtp">${tr(config.language, "card_smtp")}</button>
  <button type="button" class="fn-card setting" data-fn="backup">${tr(config.language, "card_backup")}</button>
</div>`;
    return page(tr(config.language, "title_settings"), "settings", body, script, { sidebar });
}
