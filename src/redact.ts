import { config } from "./config.js";

/**
 * P1-3 中央遮蔽層：寫 log／稽核／死信／錯誤回覆前，把憑證類字串換成 ****。
 * 兩層：精確值（chesettings 的現行 secret，零誤判，60 秒 TTL 自動跟設定走）
 * ＋形狀（沒見過的第三方回應裡夾帶的 key，保守正則）。
 * 注意：只遮「人看得到的地方」；死信 payload（重送要用）與 settings.json 本體不動。
 */

const MASK = "****";

const SHAPES: Array<{ re: RegExp; replacement: string }> = [
  // ?key=…& / ?token=…（分泌物形狀的參數名，值一定是秘密）
  { re: /([?&](?:api[_-]?key|apikey|key|token|access_token|auth|authorization|secret|password|passwd|pwd)[=:])([^&\s"']+)/gi, replacement: "$1****" },
  // Authorization: Bearer xxx
  { re: /(Bearer\s+)[A-Za-z0-9\-._~+/=]{6,}/g, replacement: "$1****" },
  // user:password@host（任何 scheme；連線字串最常見的外洩形狀）
  { re: /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:]+:)([^@/\s]+)(@)/g, replacement: "$1****$3" },
  // OpenAI / Gemini / Slack 形狀
  { re: /\b(sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z\-_]{20,}|xox[bap]-[A-Za-z0-9\-]+)/g, replacement: "****" },
  // Telegram bot token（123456:ABC…）
  { re: /\b\d{6,}:[A-Za-z0-9\-_]{20,}\b/g, replacement: "****" },
  // URL 裡的 token 片段（webhook token、簽名連結…；12 字元以上才動，避免誤傷短 id）
  { re: /(\/webhook\/|\/media\/|[?&]token=)([^/\s?"']{12,})/g, replacement: "$1****" },
];

let cache: { at: number; values: string[] } | null = null;

/** 從現行 config 收集已知的 secret 值（settings 改完 60 秒內自動跟上，不用額外接線）。 */
function knownSecrets(): string[] {
  const now = Date.now();
  if (cache && now - cache.at < 60_000) return cache.values;
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v !== "string") return;
    const s = v.trim();
    if (s.length >= 8) out.add(s);
  };
  add(config.webhookToken);
  add(config.apiToken);
  for (const t of config.apiTokens ?? []) add((t as { token?: unknown })?.token);
  add(config.line?.official?.channelAccessToken);
  add(config.line?.official?.channelSecret);
  add(config.telegram?.botToken);
  add(config.telegram?.secretToken);
  add(config.whatsapp?.accessToken);
  add(config.whatsapp?.verifyToken);
  add(config.whatsapp?.appSecret);
  add(config.teams?.appPassword);
  add(config.discord?.botToken);
  add(config.smtp?.pass);
  for (const u of ((config as { alert?: { webhookUrls?: unknown } }).alert?.webhookUrls ?? []) as unknown[]) add(u);
  add((config as { alert?: { deadmanUrl?: unknown } }).alert?.deadmanUrl);
  // 技能設定：只收 secret 形狀的 key（cwaKey、tdxClientSecret…），城市名、觸發詞這種不碰。
  for (const s of config.skills ?? []) {
    const cfg = (s as { config?: Record<string, unknown> })?.config;
    if (!cfg || typeof cfg !== "object") continue;
    for (const [k, v] of Object.entries(cfg)) {
      if (/key|token|secret|pass|auth|cred/i.test(k)) add(v);
    }
  }
  cache = { at: now, values: [...out] };
  return cache.values;
}

/** 測試用：清掉精確值快取（換設定後立即生效）。 */
export function resetRedactCache(): void {
  cache = null;
}

/** 遮蔽一段文字裡的憑證（冪等；無秘密回原文）。 */
export function redactText(input: string): string {
  if (!input) return input;
  let out = input;
  for (const v of knownSecrets()) {
    if (v && out.includes(v)) out = out.split(v).join(MASK);
  }
  for (const { re, replacement } of SHAPES) {
    re.lastIndex = 0;
    out = out.replace(re, replacement);
  }
  return out;
}
