import { config } from "../config.js";
import { logger } from "../logger.js";
import { mailConfigured, sendMailChecked } from "./mailer.js";

export type AlertChannel = "email" | "webhook";

export interface AlertOutcome {
  channel: AlertChannel;
  /** 已去敏的通道識別（webhook 只留 origin，避免把 token 寫進 log）。 */
  target: string;
  ok: boolean;
}

const WEBHOOK_TIMEOUT_MS = 10_000;

/** webhook URL 去敏：只留 origin（含 host），路徑與 query 通常藏著 token。 */
export function redactUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(無效 URL)";
  }
}

/**
 * 告警 webhook payload：同一份 JSON 同時相容常見接收端——
 * Slack Incoming Webhook 用 `text`、Discord Webhook 用 `content`、
 * ntfy 用 `title` + `message`（`topic` 由 URL 最後一段帶入）。
 */
export function buildWebhookPayload(subject: string, text: string, url: string): Record<string, string> {
  const body = `${subject}\n${text}`;
  let topic = "";
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    topic = parts[parts.length - 1] ?? "";
  } catch {
    topic = "";
  }
  return { title: subject, subject, text: body, content: body, message: body, body, topic };
}

async function postWebhook(url: string, subject: string, text: string): Promise<boolean> {
  const target = redactUrl(url);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildWebhookPayload(subject, text, url)),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.error("告警 webhook 回傳非 2xx", { target, status: res.status });
      return false;
    }
    return true;
  } catch (error) {
    logger.error("告警 webhook 送達失敗", { target, error: String(error) });
    return false;
  }
}

/**
 * C2 多通道告警：Email 與各 webhook 彼此獨立，單一通道失敗不影響其他通道。
 * 回傳每條通道的結果；**全部失敗（或一個通道都沒設定）會記 error**，
 * 因為「告警寄不出去」比「平台掛了」更容易被忽略。
 */
export async function sendAlert(subject: string, text: string): Promise<AlertOutcome[]> {
  const urls = config.alert.webhookUrls;
  const emailOn = mailConfigured();

  if (!emailOn && urls.length === 0) {
    logger.error("未設定任何告警通道（SMTP 或 ALERT_WEBHOOK_URLS），告警將只寫入 log", { subject });
    return [];
  }

  const outcomes: AlertOutcome[] = [];
  if (emailOn) {
    const ok = await sendMailChecked(subject, text);
    outcomes.push({ channel: "email", target: config.smtp.to, ok });
  }

  const results = await Promise.all(
    urls.map(async (url) => ({
      channel: "webhook" as const,
      target: redactUrl(url),
      ok: await postWebhook(url, subject, text),
    })),
  );
  outcomes.push(...results);

  if (outcomes.length > 0 && !outcomes.some((o) => o.ok)) {
    logger.error("所有告警通道皆失敗", { subject, channels: outcomes.map((o) => `${o.channel}:${o.target}`) });
  }
  return outcomes;
}

/** 告警 ping（dead-man's switch）：程式掛掉就不會 ping，由外部 uptime 服務發警。 */
export async function pingDeadman(): Promise<boolean> {
  const url = config.alert.deadmanUrl;
  if (!url) return false;
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });
    if (!res.ok) {
      logger.error("dead-man ping 回傳非 2xx", { target: redactUrl(url), status: res.status });
      return false;
    }
    return true;
  } catch (error) {
    logger.error("dead-man ping 失敗（外部 uptime 服務將在逾時後告警）", {
      target: redactUrl(url),
      error: String(error),
    });
    return false;
  }
}
