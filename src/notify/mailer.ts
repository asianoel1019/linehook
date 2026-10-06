import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { config } from "../config.js";
import { logger } from "../logger.js";

let transporter: Transporter | null = null;
let initialized = false;

export function resetMailer(): void {
  initialized = false;
  transporter = null;
}

function getTransporter(): Transporter | null {
  if (initialized) return transporter;
  initialized = true;

  const { host, port, secure, user, pass, from, to } = config.smtp;
  if (!host || !from || !to) return null;

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
  });
  return transporter;
}

function assertSafeHeader(value: string, label: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${label} 含非法換行字元`);
}

export async function sendMail(subject: string, text: string): Promise<void> {
  await sendMailChecked(subject, text);
}

/**
 * 同 sendMail，但回傳是否真的送達（C2 多通道告警要知道這一條通道有沒有成功）。
 * 未設定 SMTP 時回 false（不視為失敗通道，只代表此通道不可用）。
 */
export async function sendMailChecked(subject: string, text: string): Promise<boolean> {
  const mailer = getTransporter();
  if (!mailer) {
    logger.warn("SMTP 未設定，略過 Email 通知", { subject });
    return false;
  }

  try {
    assertSafeHeader(config.smtp.from, "寄件者");
    assertSafeHeader(config.smtp.to, "收件者");
    assertSafeHeader(subject, "主旨");
    await mailer.sendMail({
      from: config.smtp.from,
      to: config.smtp.to,
      subject,
      text,
    });
    logger.info("Email 通知已寄出", { subject, to: config.smtp.to });
    return true;
  } catch (error) {
    logger.error("Email 通知寄送失敗", { subject, error: String(error) });
    return false;
  }
}

/** SMTP 是否已設定到可寄送的程度（供告警通道判斷）。 */
export function mailConfigured(): boolean {
  const { host, from, to } = config.smtp;
  return Boolean(host && from && to);
}
