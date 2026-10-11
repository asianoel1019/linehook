/** 平台連線一次性驗證：用平台官方 API 驗證 token／webhook 狀態，供設定頁「測試連線」使用。 */

import { fetchJson } from "../net.js";

export interface ProbeValues {
  botToken?: string;
  webhookUrl?: string;
  channelAccessToken?: string;
  accessToken?: string;
  phoneNumberId?: string;
  apiVersion?: string;
  appId?: string;
  appPassword?: string;
  tenantId?: string;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

const UA = "LineHook/1.0 (platform probe)";
const TIMEOUT_MS = 12_000;

function fail(detail: string): ProbeResult {
  return { ok: false, detail };
}

async function probeTelegram(v: ProbeValues): Promise<ProbeResult> {
  const token = (v.botToken ?? "").trim();
  if (!token) return fail("尚未填 Bot Token");
  try {
    const data = await fetchJson<{
      ok?: boolean;
      result?: { url?: string; pending_update_count?: number; last_error_message?: string };
    }>(
      `https://api.telegram.org/bot${encodeURIComponent(token)}/getWebhookInfo`,
      {
        headers: { "User-Agent": UA },
      },
      { timeoutMs: TIMEOUT_MS, maxBytes: 512 * 1024 },
    );
    if (data.ok === false) return fail("Bot Token 無效（getWebhookInfo 回錯誤）");
    const r = data.result ?? {};
    const parts = [`Token 有效`];
    parts.push(r.url ? `Webhook：${r.url}` : "Webhook：尚未設定（或已用 getUpdates 長輪詢）");
    if (typeof r.pending_update_count === "number" && r.pending_update_count > 0) {
      parts.push(`待處理更新 ${r.pending_update_count} 則（代表沒人收或處理卡住）`);
    }
    if (r.last_error_message) parts.push(`上次錯誤：${r.last_error_message.slice(0, 120)}`);
    return { ok: true, detail: parts.join("\n") };
  } catch (error) {
    return fail(`Telegram 連線失敗：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function probeDiscord(v: ProbeValues): Promise<ProbeResult> {
  const token = (v.botToken ?? "").trim();
  if (!token) return fail("尚未填 Bot Token");
  try {
    const data = await fetchJson<{ id?: string; username?: string; message?: string }>(
      "https://discord.com/api/v10/users/@me",
      { headers: { "User-Agent": UA, Authorization: `Bot ${token}` } },
      { timeoutMs: TIMEOUT_MS, maxBytes: 512 * 1024 },
    );
    if (data.message) return fail(`Token 無效：${data.message}`);
    if (!data.username) return fail("驗證失敗（回應異常）");
    return {
      ok: true,
      detail: `Token 有效（Bot：${data.username}）\nDiscord 收訊走 Gateway 長連線，無 webhook 端點；發送端點 POST /webhook/discord`,
    };
  } catch (error) {
    return fail(`Discord 連線失敗：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function probeWhatsApp(v: ProbeValues): Promise<ProbeResult> {
  const token = (v.accessToken ?? "").trim();
  const phoneId = (v.phoneNumberId ?? "").trim();
  if (!token || !phoneId) return fail("尚未填 Access Token 或 Phone Number ID");
  const version = (v.apiVersion ?? "").trim() || "v21.0";
  try {
    const data = await fetchJson<{
      display_phone_number?: string;
      verified_name?: string;
      error?: { message?: string };
    }>(
      `https://graph.facebook.com/${version}/${encodeURIComponent(phoneId)}?fields=display_phone_number,verified_name`,
      {
        headers: { "User-Agent": UA },
      },
      { timeoutMs: TIMEOUT_MS, maxBytes: 512 * 1024 },
    );
    if (data.error) return fail(`Meta 拒絕：${data.error.message ?? "unknown"}`);
    const name = data.verified_name ? `（${data.verified_name}）` : "";
    return {
      ok: true,
      detail: `Token 有效：${data.display_phone_number ?? phoneId}${name}\n接收端點 GET /wa/webhook（訂閱驗證）＋ POST（訊息）`,
    };
  } catch (error) {
    return fail(`WhatsApp 連線失敗：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function probeLineOfficial(v: ProbeValues): Promise<ProbeResult> {
  const token = (v.channelAccessToken ?? "").trim();
  if (!token) return fail("尚未填 Channel access token");
  try {
    const data = await fetchJson<{
      endpoint?: string;
      active?: boolean;
      message?: string;
    }>(
      "https://api.line.me/v2/bot/channel/webhook/endpoint/info",
      {
        headers: { "User-Agent": UA, Authorization: `Bearer ${token}` },
      },
      { timeoutMs: TIMEOUT_MS, maxBytes: 512 * 1024 },
    );
    if (data.message) return fail(`LINE 拒絕：${data.message}`);
    if (!data.endpoint) return fail("查無 webhook 設定（token 可能有效但尚未註冊）");
    return {
      ok: true,
      detail: `Token 有效\nWebhook：${data.endpoint}（${data.active ? "啟用中" : "未啟用"}）`,
    };
  } catch (error) {
    return fail(`LINE 連線失敗：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function probeTeams(v: ProbeValues): Promise<ProbeResult> {
  const { appId, appPassword, tenantId } = {
    appId: (v.appId ?? "").trim(),
    appPassword: (v.appPassword ?? "").trim(),
    tenantId: (v.tenantId ?? "").trim(),
  };
  if (!appId || !appPassword) return fail("尚未填 Microsoft App ID 或 Client Secret");
  const tenant = tenantId || "common";
  try {
    const body = new URLSearchParams({
      client_id: appId,
      client_secret: appPassword,
      grant_type: "client_credentials",
      scope: "https://api.botframework.com/.default",
    });
    const data = await fetchJson<{ access_token?: string; error_description?: string; error?: string }>(
      `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
      { timeoutMs: TIMEOUT_MS, maxBytes: 512 * 1024 },
    );
    if (!data.access_token) return fail(`Entra 拒絕：${data.error_description ?? data.error ?? "unknown"}`);
    return {
      ok: true,
      detail: "Entra 驗證成功（client credentials 取得 Bot Framework token）\n接收端點 POST /teams/messages",
    };
  } catch (error) {
    return fail(`Teams 連線失敗：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 依平台探測連線。LINE 個人帳號／WhatsApp Web 無法用 API 驗證，
 * 由 route 依 line.mode／whatsapp.mode 分流處理，不進到這裡。
 */
export async function probePlatform(platform: string, values: ProbeValues): Promise<ProbeResult> {
  switch (platform) {
    case "telegram":
      return probeTelegram(values);
    case "discord":
      return probeDiscord(values);
    case "whatsapp":
      return probeWhatsApp(values);
    case "line":
      return probeLineOfficial(values);
    case "teams":
      return probeTeams(values);
    default:
      return fail(`尚不支援探測平台：${platform}`);
  }
}
