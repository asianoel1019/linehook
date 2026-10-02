export const LANGS = ["zh", "en", "ja"] as const;
export type Lang = (typeof LANGS)[number];

export const LANG_LABELS: Record<Lang, string> = {
  zh: "中文",
  en: "English",
  ja: "日本語",
};

type Entry = Record<Lang, string>;

export const DICT: Record<string, Entry> = {
  brand: { zh: "IM Webhook", en: "IM Webhook", ja: "IM Webhook" },
  nav_dashboard: { zh: "儀表板", en: "Dashboard", ja: "ダッシュボード" },
  nav_console: { zh: "功能", en: "Console", ja: "コンソール" },
  nav_skills: { zh: "技能", en: "Skills", ja: "スキル" },
  nav_settings: { zh: "設定", en: "Settings", ja: "設定" },
  nav_messages: { zh: "訊息", en: "Messages", ja: "メッセージ" },
  nav_readme: { zh: "ReadMe", en: "ReadMe", ja: "ReadMe" },
  logout: { zh: "登出", en: "Logout", ja: "ログアウト" },
  change_password: { zh: "變更密碼", en: "Change password", ja: "パスワード変更" },
  idle_logout: { zh: "閒置自動登出倒數", en: "Idle logout countdown", ja: "自動ログアウトまで" },

  login_title: { zh: "IM Webhook", en: "IM Webhook", ja: "IM Webhook" },
  login_sub: { zh: "請登入以管理", en: "Sign in to manage", ja: "ログインして管理" },
  login_user: { zh: "帳號", en: "Username", ja: "ユーザー名" },
  login_pass: { zh: "密碼", en: "Password", ja: "パスワード" },
  login_submit: { zh: "登入", en: "Sign in", ja: "ログイン" },

  pw_current: { zh: "目前密碼", en: "Current password", ja: "現在のパスワード" },
  pw_new: { zh: "新密碼", en: "New password", ja: "新しいパスワード" },
  pw_confirm: { zh: "確認新密碼", en: "Confirm new password", ja: "新しいパスワード（確認）" },
  pw_cancel: { zh: "取消", en: "Cancel", ja: "キャンセル" },
  pw_save: { zh: "儲存", en: "Save", ja: "保存" },

  title_dashboard: { zh: "儀表板", en: "Dashboard", ja: "ダッシュボード" },
  title_console: { zh: "功能", en: "Console", ja: "コンソール" },
  title_skills: { zh: "技能", en: "Skills", ja: "スキル" },
  title_settings: { zh: "設定", en: "Settings", ja: "設定" },
  title_messages: { zh: "收到的訊息", en: "Received messages", ja: "受信メッセージ" },
  title_login: { zh: "登入", en: "Login", ja: "ログイン" },

  stats_title: { zh: "發送統計", en: "Send statistics", ja: "送信統計" },
  stat_total: { zh: "總發送", en: "Total", ja: "合計" },
  stat_ok: { zh: "成功", en: "Success", ja: "成功" },
  stat_fail: { zh: "失敗", en: "Failed", ja: "失敗" },
  stat_rate: { zh: "成功率", en: "Success rate", ja: "成功率" },
  summary_title: { zh: "狀態摘要", en: "Status summary", ja: "ステータス概要" },
  recent_title: { zh: "最近發送 / 紀錄", en: "Recent activity", ja: "最近のアクティビティ" },
  no_data: { zh: "尚無資料", en: "No data", ja: "データなし" },

  card_test: { zh: "測試發送", en: "Test send", ja: "テスト送信" },
  card_targets: { zh: "目標清單", en: "Targets", ja: "送信先一覧" },
  card_logs: { zh: "最近紀錄", en: "Recent logs", ja: "最近のログ" },
  card_scheduled: { zh: "排程中的訊息", en: "Scheduled", ja: "予約メッセージ" },
  card_security: { zh: "安全 / 來源", en: "Security / Source", ja: "セキュリティ / 送信元" },
  card_line: { zh: "LINE 登入", en: "LINE login", ja: "LINE ログイン" },
  card_telegram: { zh: "Telegram", en: "Telegram", ja: "Telegram" },
  card_send: { zh: "發送 / 重試", en: "Sending / Retry", ja: "送信 / 再試行" },
  card_monitor: { zh: "監控 / Log", en: "Monitor / Log", ja: "監視 / ログ" },
  card_targets_config: { zh: "目標對照", en: "Target mapping", ja: "送信先マッピング" },
  card_templates: { zh: "訊息模板", en: "Templates", ja: "テンプレート" },
  card_autoreply: { zh: "關鍵字自動回覆", en: "Auto reply", ja: "自動返信" },
  card_forward: { zh: "訊息轉發規則", en: "Forward rules", ja: "転送ルール" },
  card_commands: { zh: "指令", en: "Commands", ja: "コマンド" },
  card_smtp: { zh: "Email 通知", en: "Email notify", ja: "メール通知" },
  card_backup: { zh: "匯出 / 匯入", en: "Export / Import", ja: "エクスポート / インポート" },
  section_actions: { zh: "操作", en: "Actions", ja: "操作" },
  section_functions: { zh: "功能", en: "Functions", ja: "機能" },
  section_settings: { zh: "設定", en: "Settings", ja: "設定" },
  section_platform: { zh: "通訊平台", en: "Platform", ja: "プラットフォーム" },
  platform_line: { zh: "LINE", en: "LINE", ja: "LINE" },
  platform_telegram: { zh: "Telegram", en: "Telegram", ja: "Telegram" },

  relogin: { zh: "Line重新登入", en: "Relogin LINE", ja: "LINE 再ログイン" },
  refresh_contacts: { zh: "重新整理聯絡人", en: "Refresh contacts", ja: "連絡先を更新" },
  language: { zh: "語言", en: "Language", ja: "言語" },

  // settings page
  settings_note: {
    zh: "設定儲存於 settings.json，修改後立即生效（LINE 裝置名稱需重新登入才生效）；點左側卡片切換設定項目。",
    en: "Settings are saved to settings.json and applied immediately (device name takes effect after re-login). Click a card on the left to switch sections.",
    ja: "設定は settings.json に保存され即時反映されます（端末名は再ログイン後に有効）。左のカードで項目を切り替えます。",
  },
  save_settings: { zh: "儲存設定", en: "Save settings", ja: "設定を保存" },
  saved: { zh: "已儲存", en: "Saved", ja: "保存しました" },

  // security
  legend_security: { zh: "安全 / 來源", en: "Security / Source", ja: "セキュリティ / 送信元" },
  lbl_allowed_ips: { zh: "允許的來源 IP", en: "Allowed source IPs", ja: "許可する送信元 IP" },
  ph_allowed_ips: { zh: "逗號或換行分隔，留空 = 不限制", en: "Comma or newline separated; empty = no limit", ja: "カンマまたは改行区切り。空欄=制限なし" },
  lbl_hmac: { zh: "HMAC 簽章密鑰", en: "HMAC secret", ja: "HMAC シークレット" },
  btn_generate: { zh: "隨機產生", en: "Generate", ja: "生成" },
  auth_enabled: { zh: "啟用此驗證方式", en: "Enable this method", ja: "この認証方式を有効化" },
  hint_auth_enabled: { zh: "關閉後此驗證方式不再被接受（建議只留一種驗證方式）", en: "When off, this method is no longer accepted (keeping one method is recommended)", ja: "オフにするとこの認証方式は受け付けなくなります（1方式のみ推奨）" },
  btn_delete: { zh: "刪除", en: "Delete", ja: "削除" },
  hint_hmac: { zh: "留空 = 不驗證簽章", en: "Empty = no signature verification", ja: "空欄=署名検証なし" },
  lbl_skew: { zh: "時間戳記容許誤差（秒）", en: "Timestamp tolerance (sec)", ja: "タイムスタンプ許容誤差（秒）" },
  lbl_webhook_token: { zh: "Webhook URL Token", en: "Webhook URL Token", ja: "Webhook URL トークン" },
  lbl_api_token: { zh: "API Token（Bearer）", en: "API Token (Bearer)", ja: "API トークン（Bearer）" },
  lbl_api_tokens: { zh: "多組 API Token", en: "Named API tokens", ja: "複数の API トークン" },
  btn_add_api_token: { zh: "新增 API Token", en: "Add API token", ja: "API トークンを追加" },
  lbl_scope: { zh: "權限", en: "Scopes", ja: "権限" },
  scope_read: { zh: "唯讀", en: "Read", ja: "読み取り" },
  scope_send: { zh: "發送", en: "Send", ja: "送信" },
  scope_admin: { zh: "管理", en: "Admin", ja: "管理" },
  token_hint_scopes: { zh: "唯讀：狀態/儀表板/訊息查詢；發送：呼叫 webhook；管理：全部（含設定修改）。留空 scopes = 無權限。", en: "read: status/dashboard/messages; send: webhook calls; admin: everything. Empty scopes = no access.", ja: "読み取り：状態/ダッシュボード/メッセージ；送信：webhook；管理：全て。空=権限なし。" },
  token_used: { zh: "已用", en: "Used", ja: "使用" },
  token_times: { zh: "次", en: " times", ja: " 回" },
  token_last: { zh: "上次", en: "Last", ja: "前回" },
  token_never_used: { zh: "尚未使用", en: "Never used", ja: "未使用" },
  lbl_admin_private: { zh: "僅限私人 IP 存取管理頁面", en: "Restrict admin pages to private IPs", ja: "管理画面をプライベート IP のみに制限" },
  lbl_rate_window: { zh: "速率限制視窗（ms）", en: "Rate limit window (ms)", ja: "レート制限ウィンドウ（ms）" },
  lbl_rate_max: { zh: "每 IP 最大請求數", en: "Max requests per IP", ja: "IP あたりの最大リクエスト数" },

  // line
  legend_line: { zh: "LINE 登入", en: "LINE login", ja: "LINE ログイン" },
  lbl_device: { zh: "裝置類型", en: "Device type", ja: "端末タイプ" },
  lbl_device_name: { zh: "顯示名稱（systemName）", en: "Display name (systemName)", ja: "表示名（systemName）" },
  lbl_model_name: { zh: "機型（modelName）", en: "Model (modelName)", ja: "機種（modelName）" },
  hint_relogin_needed: { zh: "顯示名稱需重新登入才生效", en: "Display name takes effect after re-login", ja: "表示名は再ログイン後に有効" },

  // telegram
  legend_telegram: { zh: "Telegram Bot", en: "Telegram bot", ja: "Telegram Bot" },
  lbl_tg_enabled: { zh: "啟用 Telegram Bot", en: "Enable Telegram bot", ja: "Telegram Bot を有効化" },
  lbl_tg_bot_token: { zh: "Bot Token", en: "Bot token", ja: "Bot トークン" },
  hint_tg_bot_token: { zh: "向 @BotFather 申請；留空 = 停用 Telegram", en: "Get one from @BotFather; empty = disabled", ja: "@BotFather で取得。空欄 = 無効" },
  lbl_tg_secret: { zh: "Webhook Secret Token", en: "Webhook secret token", ja: "Webhook シークレット" },
  hint_tg_secret: { zh: "設定後 Telegram 會以此密鑰傳送 update（X-Telegram-Bot-Api-Secret-Token），建議設定", en: "If set, Telegram sends updates with this secret header; recommended", ja: "設定するとこのシークレットで update を送信します（推奨）" },
  lbl_tg_webhook: { zh: "Webhook URL", en: "Webhook URL", ja: "Webhook URL" },
  hint_tg_webhook: { zh: "對外可存取的網址，結尾固定為 /tg/update；設定後重啟會自動註冊", en: "Public URL ending with /tg/update; registered on startup when set", ja: "外部から到達可能な URL（末尾 /tg/update）。設定すると起動時に自動登録" },
  lbl_tg_targets: { zh: "目標對照（名稱=chat_id）", en: "Target mapping (name=chat_id)", ja: "送信先（名称=chat_id）" },
  hint_tg_targets: { zh: "每行一筆，例如：我的群組=-1001234567890；也可填 @username", en: "One per line, e.g. MyGroup=-1001234567890; @username also works", ja: "1 行に 1 件（例 MyGroup=-1001234567890）。@username も可" },

  // send
  legend_send: { zh: "發送 / 重試", en: "Sending / Retry", ja: "送信 / 再試行" },
  lbl_max_retries: { zh: "最大重試次數", en: "Max retries", ja: "最大再試行回数" },
  lbl_retry_base: { zh: "重試退避基準（ms）", en: "Retry backoff base (ms)", ja: "再試行バックオフ基準（ms）" },
  lbl_min_interval: { zh: "最小發送間隔（ms）", en: "Min send interval (ms)", ja: "最小送信間隔（ms）" },
  lbl_reply_max: { zh: "回覆文字上限（字元）", en: "Max reply length (chars)", ja: "返信テキスト上限（文字）" },
  hint_reply_max: { zh: "超過會自動分段送出；0 = 不限制", en: "Longer replies are split automatically; 0 = unlimited", ja: "超過分は自動分割して送信。0 = 無制限" },

  // monitor
  legend_monitor: { zh: "監控 / Log", en: "Monitor / Log", ja: "監視 / ログ" },
  lbl_timezone: { zh: "時區", en: "Timezone", ja: "タイムゾーン" },
  hint_timezone: { zh: "IANA 時區名稱（例如 Asia/Taipei、UTC），影響 log 時間與技能（如「今天」的判斷）", en: "IANA timezone (e.g. Asia/Taipei, UTC); affects log time and skills (e.g. \"today\")", ja: "IANA タイムゾーン（例 Asia/Taipei、UTC）。ログ時刻とスキルに影響します" },
  lbl_health_interval: { zh: "健康檢查間隔（秒）", en: "Health check interval (sec)", ja: "ヘルスチェック間隔（秒）" },
  lbl_log_limit: { zh: "記憶體保留紀錄筆數", en: "In-memory log entries", ja: "メモリ保持ログ件数" },
  lbl_log_max_bytes: { zh: "Log 輪替大小（bytes）", en: "Log rotate size (bytes)", ja: "ログローテートサイズ（bytes）" },
  lbl_log_max_files: { zh: "Log 保留檔數", en: "Log files to keep", ja: "ログ保持ファイル数" },
  lbl_messages_persist: { zh: "持久化收到的訊息", en: "Persist received messages", ja: "受信メッセージを保存" },

  // targets config
  legend_targets: { zh: "目標對照（TARGETS）", en: "Target mapping (TARGETS)", ja: "送信先マッピング（TARGETS）" },
  lbl_name_mid: { zh: "名稱=mid", en: "name=mid", ja: "名前=mid" },

  // templates
  legend_templates: { zh: "訊息模板（Templates）", en: "Message templates", ja: "メッセージテンプレート" },
  lbl_btn_add_template: { zh: "新增模板", en: "Add template", ja: "テンプレートを追加" },
  lbl_btn_add_flex: { zh: "新增 Flex 樣板", en: "Add Flex template", ja: "Flex テンプレートを追加" },

  // auto reply
  legend_autoreply: { zh: "關鍵字自動回覆", en: "Auto reply", ja: "自動返信" },
  lbl_autoreply_enabled: { zh: "啟用自動回覆", en: "Enable auto reply", ja: "自動返信を有効化" },
  lbl_cooldown: { zh: "回覆冷卻（秒）", en: "Cooldown (sec)", ja: "クールダウン（秒）" },
  btn_add_rule: { zh: "新增規則", en: "Add rule", ja: "ルールを追加" },

  // forward
  legend_forward: { zh: "訊息轉發規則", en: "Forward rules", ja: "転送ルール" },
  btn_add_forward: { zh: "新增轉發規則", en: "Add forward rule", ja: "転送ルールを追加" },

  // skills
  legend_skills: { zh: "技能（Skills）", en: "Skills", ja: "スキル" },
  lbl_assistant_enabled: { zh: "啟用助理", en: "Enable assistant", ja: "アシスタントを有効化" },
  hint_assistant: { zh: "開啟後，訊息以「名稱」開頭即會呼叫技能，例如「阿寶請幫忙 火車 台北 到 高雄」", en: "When on, a message starting with the assistant name calls a skill, e.g. \"Abao please train Taipei to Kaohsiung\"", ja: "有効にすると、メッセージが名前で始まるとスキルを呼び出します" },
  lbl_assistant_name: { zh: "助理名稱", en: "Assistant name", ja: "アシスタント名" },
  btn_add_skill: { zh: "新增技能", en: "Add skill", ja: "スキルを追加" },
  btn_upload: { zh: "上傳檔案", en: "Upload", ja: "アップロード" },
  btn_list_models: { zh: "列出模型", en: "List models", ja: "モデル一覧" },
  title_library: { zh: "技能庫", en: "Skill library", ja: "スキルライブラリ" },
  btn_download: { zh: "下載", en: "Download", ja: "ダウンロード" },
  btn_install: { zh: "安裝", en: "Install", ja: "インストール" },
  btn_uninstall: { zh: "移除", en: "Remove", ja: "削除" },
  lbl_install_skill: { zh: "安裝技能（上傳 .zip）", en: "Install skill (upload .zip)", ja: "スキルをインストール（.zip）" },
  hint_install: { zh: "zip 內含技能的 index.js（可含 skill.json）。安裝後立即生效。", en: "The zip contains the skill's index.js (optionally skill.json). Takes effect immediately.", ja: "zip に index.js（任意で skill.json）を含めます。即時反映。" },
  no_installed: { zh: "尚未安裝任何外部技能。", en: "No external skills installed.", ja: "外部スキルは未インストールです。" },
  hint_library: { zh: "下載技能 zip 後，回到「技能」頁上傳安裝即可使用。", en: "Download a skill zip, then upload it on the Skills page to install.", ja: "スキルの zip をダウンロードし、スキルページでアップロードしてインストールします。" },
  lbl_trigger: { zh: "觸發詞", en: "Trigger", ja: "トリガー" },
  lbl_expand: { zh: "展開 / 收起設定", en: "Expand / collapse", ja: "設定を展開 / 折りたたむ" },
  skill_trigger_any: { zh: "此技能會檢查每一則收到的訊息（不需觸發詞）", en: "This skill checks every incoming message (no trigger word)", ja: "このスキルは受信メッセージごとに確認します（トリガー不要）" },
  hint_skills: { zh: "技能為可插拔的子專案；啟用後可用「<助理名稱>請幫忙 <觸發詞> …」呼叫。目前內建：火車時刻表。", en: "Skills are pluggable sub-projects. After enabling, call with \"<assistant> please <trigger> …\". Built-in: train timetable.", ja: "スキルはプラグイン可能なサブプロジェクトです。有効後「<名前> で <トリガー> …」で呼び出せます。内蔵：列車時刻表。" },
  card_skills: { zh: "技能", en: "Skills", ja: "スキル" },
  no_skills: { zh: "尚未載入任何技能（請確認 src/skills 下的資料夾存在）", en: "No skills loaded (check folders under src/skills)", ja: "スキルが読み込まれていません（src/skills のフォルダを確認）" },

  // skill help (LINE)
  help_title: { zh: "可用技能", en: "Available skills", ja: "利用可能なスキル" },
  help_call: { zh: "請幫忙 <觸發詞>", en: "please <trigger>", ja: "で <トリガー>" },
  help_other: { zh: "其他", en: "Other", ja: "その他" },
  help_no_skills: { zh: "目前沒有可用技能（請先在設定頁啟用）。", en: "No skills available (enable them on the settings page first).", ja: "利用可能なスキルがありません（設定ページで有効化してください）。" },
  help_layer2: { zh: "輸入「{asst}請幫忙 <觸發詞> ?」可看該技能用法", en: "Send \"{asst} please <trigger> ?\" to see a skill's usage", ja: "「{asst} <トリガー> ?」で使い方を表示" },
  help_usage: { zh: "用法", en: "Usage", ja: "使い方" },
  help_aliases: { zh: "別名", en: "Aliases", ja: "別名" },
  help_settings: { zh: "設定", en: "Settings", ja: "設定" },
  help_secret: { zh: "需設定", en: "required", ja: "設定が必要" },

  // commands
  legend_commands: { zh: "指令", en: "Commands", ja: "コマンド" },
  lbl_commands_enabled: { zh: "啟用指令", en: "Enable commands", ja: "コマンドを有効化" },
  lbl_commands_prefix: { zh: "指令前綴", en: "Command prefix", ja: "コマンド接頭辞" },
  lbl_commands_allow: { zh: "允許來源", en: "Allowed sources", ja: "許可する送信元" },
  ph_commands_allow: { zh: "留空 = 所有人；每行一個 mid 或 chat mid", en: "Empty = everyone; one mid or chat mid per line", ja: "空欄=全員。1行に1つの mid または chat mid" },

  // smtp
  legend_smtp: { zh: "Email 通知（SMTP）", en: "Email notification (SMTP)", ja: "メール通知（SMTP）" },
  lbl_smtp_from: { zh: "寄件者（From）", en: "Sender (From)", ja: "送信元（From）" },
  lbl_smtp_to: { zh: "收件者（To）", en: "Recipient (To)", ja: "宛先（To）" },

  // backup
  legend_backup: { zh: "設定匯出 / 匯入", en: "Export / Import", ja: "エクスポート / インポート" },
  btn_export: { zh: "匯出設定", en: "Export settings", ja: "設定をエクスポート" },
  btn_import: { zh: "匯入設定", en: "Import settings", ja: "設定をインポート" },

  // row controls
  btn_delete_rule: { zh: "刪除規則", en: "Delete rule", ja: "ルールを削除" },
  btn_delete_template: { zh: "刪除模板", en: "Delete template", ja: "テンプレートを削除" },
  btn_delete_flex: { zh: "刪除樣板", en: "Delete template", ja: "テンプレートを削除" },
  lbl_keyword: { zh: "關鍵字（| 分隔）", en: "Keywords (| separated)", ja: "キーワード（| 区切り）" },
  lbl_match_type: { zh: "比對方式", en: "Match type", ja: "一致方法" },
  lbl_reply_text: { zh: "回覆文字", en: "Reply text", ja: "返信テキスト" },
  lbl_reply_image: { zh: "回覆圖片", en: "Reply image", ja: "返信画像" },
  lbl_file_path: { zh: "檔案路徑", en: "File path", ja: "ファイルパス" },
  lbl_filename: { zh: "檔名", en: "Filename", ja: "ファイル名" },
  lbl_enabled: { zh: "啟用", en: "Enabled", ja: "有効" },
  match_exact: { zh: "完全相符", en: "Exact", ja: "完全一致" },
  match_contains: { zh: "包含", en: "Contains", ja: "含む" },
  match_regex: { zh: "正則", en: "Regex", ja: "正規表現" },
  match_all: { zh: "全部", en: "All", ja: "すべて" },
  lbl_source: { zh: "來源", en: "Source", ja: "送信元" },
  lbl_forward_target: { zh: "轉發對象", en: "Forward to", ja: "転送先" },
  lbl_prefix: { zh: "前綴", en: "Prefix", ja: "接頭辞" },
  lbl_include_sender: { zh: "附上來源名稱", en: "Include sender name", ja: "送信元名を含める" },
  lbl_name: { zh: "名稱", en: "Name", ja: "名前" },
  lbl_alt_text: { zh: "altText", en: "altText", ja: "altText" },
  lbl_flex_json: { zh: "Flex JSON", en: "Flex JSON", ja: "Flex JSON" },
  lbl_content: { zh: "內容", en: "Content", ja: "内容" },

  // console
  panel_test: { zh: "測試發送", en: "Test send", ja: "テスト送信" },
  panel_targets: { zh: "目標清單", en: "Targets", ja: "送信先一覧" },
  panel_logs: { zh: "最近紀錄", en: "Recent logs", ja: "最近のログ" },
  panel_scheduled: { zh: "排程中的訊息", en: "Scheduled messages", ja: "予約メッセージ" },
  lbl_to: { zh: "對象", en: "Recipient", ja: "宛先" },
  lbl_text: { zh: "文字", en: "Text", ja: "テキスト" },
  lbl_image: { zh: "圖片（URL 或路徑）", en: "Image (URL or path)", ja: "画像（URL またはパス）" },
  lbl_video: { zh: "影片（URL 或路徑）", en: "Video (URL or path)", ja: "動画（URL またはパス）" },
  lbl_audio: { zh: "語音（URL 或路徑）", en: "Audio (URL or path)", ja: "音声（URL またはパス）" },
  lbl_display_filename: { zh: "顯示檔名", en: "Display filename", ja: "表示ファイル名" },
  summary_advanced: { zh: "進階（貼圖 / 位置 / Flex / 延遲）", en: "Advanced (sticker / location / Flex / delay)", ja: "詳細（スタンプ / 位置 / Flex / 遅延）" },
  lbl_sticker_pkg: { zh: "貼圖 packageId", en: "Sticker packageId", ja: "スタンプ packageId" },
  lbl_sticker_id: { zh: "貼圖 stickerId", en: "Sticker stickerId", ja: "スタンプ stickerId" },
  lbl_loc_title: { zh: "位置標題", en: "Location title", ja: "位置タイトル" },
  lbl_loc_address: { zh: "位置地址", en: "Location address", ja: "位置アドレス" },
  lbl_lat_lng: { zh: "緯度 / 經度", en: "Latitude / Longitude", ja: "緯度 / 経度" },
  lbl_flex_alt: { zh: "Flex altText", en: "Flex altText", ja: "Flex altText" },
  lbl_delay: { zh: "延遲發送", en: "Delayed send", ja: "遅延送信" },
  btn_send: { zh: "發送", en: "Send", ja: "送信" },
  panel_flex_editor: { zh: "Flex 可視化編輯", en: "Flex visual editor", ja: "Flex ビジュアル編集" },
  fx_show_hero: { zh: "顯示主圖", en: "Show hero image", ja: "ヒーロー画像を表示" },
  fx_hero_url: { zh: "主圖 URL", en: "Hero image URL", ja: "ヒーロー画像 URL" },
  fx_hero_ratio: { zh: "主圖比例", en: "Hero aspect ratio", ja: "ヒーロー画像比率" },
  fx_title: { zh: "標題", en: "Title", ja: "タイトル" },
  fx_body: { zh: "內文", en: "Body text", ja: "本文" },
  fx_buttons: { zh: "按鈕（最多 3 個）", en: "Buttons (max 3)", ja: "ボタン（最大3個）" },
  fx_btn_add: { zh: "新增按鈕", en: "Add button", ja: "ボタンを追加" },
  fx_btn_label: { zh: "按鈕文字", en: "Label", ja: "ラベル" },
  fx_btn_action: { zh: "動作", en: "Action", ja: "アクション" },
  fx_action_message: { zh: "傳送文字", en: "Send text", ja: "テキスト送信" },
  fx_action_uri: { zh: "開啟連結", en: "Open URL", ja: "URLを開く" },
  fx_btn_value: { zh: "文字 / 連結", en: "Text / URL", ja: "テキスト / URL" },
  fx_preview: { zh: "預覽（示意）", en: "Preview (approx.)", ja: "プレビュー（参考）" },
  fx_json_out: { zh: "產生的 Flex JSON", en: "Generated Flex JSON", ja: "生成された Flex JSON" },
  fx_fill_test: { zh: "填入測試表單", en: "Fill test form", ja: "テストフォームに入力" },
  fx_copy: { zh: "複製 JSON", en: "Copy JSON", ja: "JSONをコピー" },
  fx_copied: { zh: "已複製", en: "Copied", ja: "コピーしました" },
  fx_filled: { zh: "已填入測試表單", en: "Filled into test form", ja: "テストフォームに入力しました" },
  fx_preview_empty: { zh: "在左側輸入內容，右側即時預覽", en: "Type on the left to preview", ja: "左側に入力するとプレビュー" },
  fx_empty: { zh: "內容為空，請先填寫", en: "Empty content", ja: "内容が空です" },
  btn_cancel: { zh: "取消", en: "Cancel", ja: "キャンセル" },
  btn_edit_time: { zh: "改變時間", en: "Change time", ja: "時間を変更" },
  th_time: { zh: "時間", en: "Time", ja: "時刻" },
  th_level: { zh: "等級", en: "Level", ja: "レベル" },
  th_message: { zh: "訊息", en: "Message", ja: "メッセージ" },
  th_content: { zh: "內容", en: "Content", ja: "内容" },
  th_name: { zh: "名稱", en: "Name", ja: "名前" },
  th_mid: { zh: "MID", en: "MID", ja: "MID" },
  th_actions: { zh: "操作", en: "Actions", ja: "操作" },
  th_target: { zh: "對象", en: "Recipient", ja: "宛先" },
  th_repeat: { zh: "重複", en: "Repeat", ja: "繰り返し" },
  th_source: { zh: "來源", en: "Source", ja: "送信元" },
  th_chat: { zh: "對話", en: "Chat", ja: "チャット" },
  btn_copy_mapping: { zh: "複製對應", en: "Copy mapping", ja: "マッピングをコピー" },
  btn_test: { zh: "測試", en: "Test", ja: "テスト" },
  ph_search: { zh: "搜尋名稱或 MID", en: "Search name or MID", ja: "名前または MID を検索" },
  list_count: { zh: "清單", en: "List", ja: "一覧" },

  // dashboard summary labels
  sum_status: { zh: "登入狀態", en: "Login status", ja: "ログイン状態" },
  sum_name: { zh: "帳號名稱", en: "Account name", ja: "アカウント名" },
  sum_mid: { zh: "我的 MID", en: "My MID", ja: "自分の MID" },
  sum_friends: { zh: "好友數", en: "Friends", ja: "友だち数" },
  sum_groups: { zh: "群組數", en: "Groups", ja: "グループ数" },
  sum_queue: { zh: "佇列等待", en: "Queue", ja: "キュー" },
  sum_last_login: { zh: "最後登入", en: "Last login", ja: "最終ログイン" },
  sum_last_send: { zh: "最後發送時間", en: "Last send", ja: "最終送信" },
  sum_last_to: { zh: "最後發送對象", en: "Last recipient", ja: "最終送信先" },
  sum_last_error: { zh: "最後錯誤", en: "Last error", ja: "最終エラー" },
  sum_started: { zh: "啟動時間", en: "Started at", ja: "起動時刻" },
  sending: { zh: "發送中", en: "sending", ja: "送信中" },
  type_label: { zh: "類型", en: "Types", ja: "種類" },
  no_send_records: { zh: "尚無發送紀錄", en: "No send records yet", ja: "送信記録はまだありません" },
};

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

export function tr(lang: Lang, key: string): string {
  const entry = DICT[key];
  if (!entry) return key;
  return entry[lang] ?? entry.zh;
}

export function langMap(lang: Lang): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(DICT)) out[key] = entry[lang] ?? entry.zh;
  return out;
}
