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
  const mailer = getTransporter();
  if (!mailer) {
    logger.warn("SMTP 未設定，略過 Email 通知", { subject });
    return;
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
  } catch (error) {
    logger.error("Email 通知寄送失敗", { subject, error: String(error) });
  }
}
