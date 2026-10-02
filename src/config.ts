import "dotenv/config";
import { z } from "zod";
import type { Device } from "@evex/linejs/base";

export const DEVICES = [
  "DESKTOPWIN",
  "DESKTOPMAC",
  "ANDROID",
  "ANDROIDSECONDARY",
  "IOS",
  "IOSIPAD",
  "WATCHOS",
  "WEAROS",
] as const;

function boolDefault(fallback: boolean) {
  return z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === "") return fallback;
      return ["1", "true", "yes", "on"].includes(value.toLowerCase());
    });
}

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8090),
  SETTINGS_PATH: z.string().default("./settings.json"),
  ALLOWED_IPS: z.string().default(""),
  HMAC_SECRET: z.string().trim().default(""),
  HMAC_ENABLED: boolDefault(true),
  HMAC_MAX_SKEW_SEC: z.coerce.number().int().nonnegative().default(300),
  WEBHOOK_TOKEN: z.string().trim().default(""),
  WEBHOOK_TOKEN_ENABLED: boolDefault(true),
  API_TOKEN: z.string().trim().default(""),
  API_TOKEN_ENABLED: boolDefault(true),
  STATUS_PUBLIC: boolDefault(true),
  ADMIN_PRIVATE_ONLY: boolDefault(false),
  STATUS_USER: z.string().default(""),
  STATUS_PASS: z.string().default(""),
  AUTH_PATH: z.string().default("./data/auth.json"),
  LANGUAGE: z.enum(["zh", "en", "ja"]).default("zh"),
  TIMEZONE: z.string().default("Asia/Taipei"),
  LINE_DEVICE: z.enum(DEVICES).default("DESKTOPWIN"),
  LINE_DEVICE_NAME: z.string().default("IM Webhook"),
  LINE_MODEL_NAME: z.string().default("IM Webhook"),
  STORAGE_PATH: z.string().default("./storage.json"),
  TARGETS: z.string().default(""),
  TELEGRAM_ENABLED: boolDefault(false),
  TELEGRAM_BOT_TOKEN: z.string().trim().default(""),
  TELEGRAM_SECRET_TOKEN: z.string().trim().default(""),
  TELEGRAM_WEBHOOK_URL: z.string().trim().default(""),
  TELEGRAM_TARGETS: z.string().default(""),
  HEALTH_CHECK_INTERVAL_SEC: z.coerce.number().int().positive().default(60),
  LOG_LIMIT: z.coerce.number().int().positive().default(200),
  LOG_FILE: z.string().default("./logs/app.log"),
  LOG_MAX_BYTES: z.coerce.number().int().positive().default(5242880),
  LOG_MAX_FILES: z.coerce.number().int().min(1).default(5),
  MESSAGES_PATH: z.string().default("./data/messages.jsonl"),
  MESSAGES_PERSIST: boolDefault(false),
  SCHEDULES_PATH: z.string().default("./data/schedules.json"),
  STATS_PATH: z.string().default("./data/stats.jsonl"),
  STATS_DAYS: z.coerce.number().int().min(1).default(14),
  UPLOADS_PATH: z.string().default("./data/uploads"),
  SKILLS_PATH: z.string().default("./data/skills"),
  CACHE_PATH: z.string().default("./data/cache"),
  MAX_BODY_MB: z.coerce.number().int().positive().default(25),
  SEND_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  SEND_RETRY_BASE_MS: z.coerce.number().int().positive().default(500),
  SEND_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(200),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  REPLY_MAX_CHARS: z.coerce.number().int().nonnegative().default(4000),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: boolDefault(false),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  MAIL_FROM: z.string().default(""),
  MAIL_TO: z.string().default(""),
});

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTargets(value: string): Record<string, string> {
  const targets: Record<string, string> = {};
  for (const pair of parseList(value)) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const mid = pair.slice(index + 1).trim();
    if (name && mid) targets[name] = mid;
  }
  return targets;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
}

export interface ForwardRule {
  id: string;
  enabled: boolean;
  match: "contains" | "regex" | "all";
  keyword: string;
  source: string;
  target: string;
  includeSender: boolean;
  prefix: string;
}

export type ApiScope = "read" | "send" | "admin";

export const API_SCOPES: ApiScope[] = ["read", "send", "admin"];

export interface ApiTokenEntry {
  name: string;
  token: string;
  scopes: ApiScope[];
}

export interface CommandConfig {
  enabled: boolean;
  prefix: string;
  allowFrom: string[];
}

export interface AssistantConfig {
  enabled: boolean;
  name: string;
}

export interface MessageTemplate {
  name: string;
  text: string;
}

export interface FlexTemplate {
  name: string;
  altText: string;
  contents: string;
}

export interface SkillConfig {
  id: string;
  enabled: boolean;
  trigger: string;
  config: Record<string, string>;
}

export interface Config {
  port: number;
  settingsPath: string;
  allowedIps: string[];
  hmacSecret: string;
  hmacEnabled: boolean;
  hmacMaxSkewSec: number;
  webhookToken: string;
  webhookTokenEnabled: boolean;
  apiToken: string;
  apiTokenEnabled: boolean;
  apiTokens: ApiTokenEntry[];
  statusPublic: boolean;
  adminPrivateOnly: boolean;
  status: {
    user: string;
    pass: string;
  };
  authPath: string;
  language: import("./i18n.js").Lang;
  timezone: string;
  line: {
    device: Device;
    deviceName: string;
    modelName: string;
    storagePath: string;
  };
  targets: Record<string, string>;
  telegram: {
    enabled: boolean;
    botToken: string;
    secretToken: string;
    webhookUrl: string;
    targets: Record<string, string>;
  };
  templates: MessageTemplate[];
  flexTemplates: FlexTemplate[];
  healthCheckIntervalSec: number;
  logLimit: number;
  logFile: string;
  logMaxBytes: number;
  logMaxFiles: number;
  messagesPath: string;
  messagesPersist: boolean;
  schedulesPath: string;
  statsPath: string;
  statsDays: number;
  uploadsPath: string;
  skillsPath: string;
  cachePath: string;
  maxBodyMb: number;
  send: {
    maxRetries: number;
    retryBaseMs: number;
    minIntervalMs: number;
  };
  rateLimit: {
    windowMs: number;
    max: number;
  };
  replyMaxChars: number;
  smtp: SmtpConfig;
  forward: ForwardRule[];
  commands: CommandConfig;
  assistant: AssistantConfig;
  skills: SkillConfig[];
}

const rawEnv: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && value !== "") rawEnv[key] = value;
}

const parsed = schema.safeParse(rawEnv);
if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  const hasDeviceIssue = parsed.error.issues.some(
    (issue) => issue.path.join(".") === "LINE_DEVICE",
  );
  const hint = hasDeviceIssue
    ? "\n提示：LINE_DEVICE 只能填裝置類型（DESKTOPWIN / ANDROID / IOS 等）；要自訂 LINE 顯示的名稱請用 LINE_DEVICE_NAME。"
    : "";
  throw new Error(`環境變數設定錯誤：\n${details}${hint}`);
}

const env = parsed.data;

export const config: Config = {
  port: env.PORT,
  settingsPath: env.SETTINGS_PATH,
  allowedIps: parseList(env.ALLOWED_IPS),
  hmacSecret: env.HMAC_SECRET,
  hmacEnabled: env.HMAC_ENABLED,
  hmacMaxSkewSec: env.HMAC_MAX_SKEW_SEC,
  webhookToken: env.WEBHOOK_TOKEN,
  webhookTokenEnabled: env.WEBHOOK_TOKEN_ENABLED,
  apiToken: env.API_TOKEN,
  apiTokenEnabled: env.API_TOKEN_ENABLED,
  apiTokens: [],
  statusPublic: env.STATUS_PUBLIC,
  adminPrivateOnly: env.ADMIN_PRIVATE_ONLY,
  status: {
    user: env.STATUS_USER,
    pass: env.STATUS_PASS,
  },
  authPath: env.AUTH_PATH,
  language: env.LANGUAGE,
  timezone: env.TIMEZONE,
  line: {
    device: env.LINE_DEVICE,
    deviceName: env.LINE_DEVICE_NAME,
    modelName: env.LINE_MODEL_NAME,
    storagePath: env.STORAGE_PATH,
  },
  targets: parseTargets(env.TARGETS),
  telegram: {
    enabled: env.TELEGRAM_ENABLED,
    botToken: env.TELEGRAM_BOT_TOKEN,
    secretToken: env.TELEGRAM_SECRET_TOKEN,
    webhookUrl: env.TELEGRAM_WEBHOOK_URL,
    targets: parseTargets(env.TELEGRAM_TARGETS),
  },
  templates: [],
  flexTemplates: [],
  healthCheckIntervalSec: env.HEALTH_CHECK_INTERVAL_SEC,
  logLimit: env.LOG_LIMIT,
  logFile: env.LOG_FILE,
  logMaxBytes: env.LOG_MAX_BYTES,
  logMaxFiles: env.LOG_MAX_FILES,
  messagesPath: env.MESSAGES_PATH,
  messagesPersist: env.MESSAGES_PERSIST,
  schedulesPath: env.SCHEDULES_PATH,
  statsPath: env.STATS_PATH,
  statsDays: env.STATS_DAYS,
  uploadsPath: env.UPLOADS_PATH,
  skillsPath: env.SKILLS_PATH,
  cachePath: env.CACHE_PATH,
  maxBodyMb: env.MAX_BODY_MB,
  send: {
    maxRetries: env.SEND_MAX_RETRIES,
    retryBaseMs: env.SEND_RETRY_BASE_MS,
    minIntervalMs: env.SEND_MIN_INTERVAL_MS,
  },
  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
  },
  replyMaxChars: env.REPLY_MAX_CHARS,
  smtp: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM,
    to: env.MAIL_TO,
  },
  forward: [],
  commands: {
    enabled: false,
    prefix: "!",
    allowFrom: [],
  },
  assistant: {
    enabled: false,
    name: "阿寶",
  },
  skills: [],
};
