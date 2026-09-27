import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { config, DEVICES } from "./config.js";
import { logger } from "./logger.js";
import { resetMailer } from "./notify/mailer.js";

const settingsSchema = z.object({
  allowedIps: z.array(z.string()).default([]),
  hmacSecret: z.string().trim().default(""),
  hmacMaxSkewSec: z.coerce.number().int().nonnegative().default(300),
  webhookToken: z.string().trim().default(""),
  apiToken: z.string().trim().default(""),
  apiTokens: z
    .array(
      z.object({
        name: z.string().default(""),
        token: z.string().trim().default(""),
      }),
    )
    .default([]),
  statusPublic: z.boolean().default(true),
  adminPrivateOnly: z.boolean().default(false),
  targets: z.record(z.string(), z.string()).default({}),
  templates: z
    .array(
      z.object({
        name: z.string().default(""),
        text: z.string().default(""),
      }),
    )
    .default([]),
  flexTemplates: z
    .array(
      z.object({
        name: z.string().default(""),
        altText: z.string().default(""),
        contents: z.string().default(""),
      }),
    )
    .default([]),
  healthCheckIntervalSec: z.coerce.number().int().positive().default(60),
  logLimit: z.coerce.number().int().positive().default(200),
  logMaxBytes: z.coerce.number().int().positive().default(5242880),
  logMaxFiles: z.coerce.number().int().min(1).default(5),
  messagesPersist: z.boolean().default(false),
  send: z.object({
    maxRetries: z.coerce.number().int().min(0).default(3),
    retryBaseMs: z.coerce.number().int().positive().default(500),
    minIntervalMs: z.coerce.number().int().nonnegative().default(200),
  }),
  rateLimit: z.object({
    windowMs: z.coerce.number().int().positive().default(60000),
    max: z.coerce.number().int().positive().default(60),
  }),
  line: z.object({
    device: z.enum(DEVICES).default("DESKTOPWIN"),
    deviceName: z.string().default("LINE Webhook"),
    modelName: z.string().default("LINE Webhook"),
  }),
  smtp: z.object({
    host: z.string().default(""),
    port: z.coerce.number().int().positive().default(587),
    secure: z.boolean().default(false),
    user: z.string().default(""),
    pass: z.string().default(""),
    from: z.string().default(""),
    to: z.string().default(""),
  }),
  autoReply: z
    .object({
      enabled: z.boolean().default(false),
      cooldownSec: z.coerce.number().int().min(0).default(10),
      rules: z
        .array(
          z.object({
            keyword: z.string().default(""),
            match: z.enum(["exact", "contains", "regex"]).default("exact"),
            text: z.string().default(""),
            filePath: z.string().default(""),
            filename: z.string().default(""),
            image: z.string().default(""),
            enabled: z.boolean().default(true),
          }),
        )
        .default([]),
    })
    .default({ enabled: false, cooldownSec: 10, rules: [] }),
  forward: z
    .array(
      z.object({
        id: z.string().default(""),
        enabled: z.boolean().default(true),
        match: z.enum(["contains", "regex", "all"]).default("contains"),
        keyword: z.string().default(""),
        source: z.string().default(""),
        target: z.string().default(""),
        includeSender: z.boolean().default(false),
        prefix: z.string().default(""),
      }),
    )
    .default([]),
  commands: z
    .object({
      enabled: z.boolean().default(false),
      prefix: z.string().default("!"),
      allowFrom: z.array(z.string()).default([]),
    })
    .default({ enabled: false, prefix: "!", allowFrom: [] }),
});

export type EditableSettings = z.infer<typeof settingsSchema>;

export function currentSettings(): EditableSettings {
  return {
    allowedIps: [...config.allowedIps],
    hmacSecret: config.hmacSecret,
    hmacMaxSkewSec: config.hmacMaxSkewSec,
    webhookToken: config.webhookToken,
    apiToken: config.apiToken,
    apiTokens: config.apiTokens.map((item) => ({ ...item })),
    statusPublic: config.statusPublic,
    adminPrivateOnly: config.adminPrivateOnly,
    targets: { ...config.targets },
    templates: config.templates.map((template) => ({ ...template })),
    flexTemplates: config.flexTemplates.map((template) => ({ ...template })),
    healthCheckIntervalSec: config.healthCheckIntervalSec,
    logLimit: config.logLimit,
    logMaxBytes: config.logMaxBytes,
    logMaxFiles: config.logMaxFiles,
    messagesPersist: config.messagesPersist,
    send: { ...config.send },
    rateLimit: { ...config.rateLimit },
    line: {
      device: config.line.device,
      deviceName: config.line.deviceName,
      modelName: config.line.modelName,
    },
    smtp: { ...config.smtp },
    autoReply: {
      enabled: config.autoReply.enabled,
      cooldownSec: config.autoReply.cooldownSec,
      rules: config.autoReply.rules.map((rule) => ({ ...rule })),
    },
    forward: config.forward.map((rule) => ({ ...rule })),
    commands: {
      enabled: config.commands.enabled,
      prefix: config.commands.prefix,
      allowFrom: [...config.commands.allowFrom],
    },
  };
}

function apply(settings: EditableSettings): void {
  config.allowedIps = settings.allowedIps;
  config.hmacSecret = settings.hmacSecret;
  config.hmacMaxSkewSec = settings.hmacMaxSkewSec;
  config.webhookToken = settings.webhookToken;
  config.apiToken = settings.apiToken;
  config.apiTokens = settings.apiTokens.map((item) => ({ ...item }));
  config.statusPublic = settings.statusPublic;
  config.adminPrivateOnly = settings.adminPrivateOnly;
  config.targets = settings.targets;
  config.templates = settings.templates.map((template) => ({ ...template }));
  config.flexTemplates = settings.flexTemplates.map((template) => ({ ...template }));
  config.healthCheckIntervalSec = settings.healthCheckIntervalSec;
  config.logLimit = settings.logLimit;
  config.logMaxBytes = settings.logMaxBytes;
  config.logMaxFiles = settings.logMaxFiles;
  config.messagesPersist = settings.messagesPersist;
  config.send = { ...settings.send };
  config.rateLimit = { ...settings.rateLimit };
  config.line.device = settings.line.device;
  config.line.deviceName = settings.line.deviceName;
  config.line.modelName = settings.line.modelName;
  config.smtp = { ...settings.smtp };
  config.autoReply = {
    enabled: settings.autoReply.enabled,
    cooldownSec: settings.autoReply.cooldownSec,
    rules: settings.autoReply.rules.map((rule) => ({ ...rule })),
  };
  config.forward = settings.forward.map((rule) => ({ ...rule }));
  config.commands = {
    enabled: settings.commands.enabled,
    prefix: settings.commands.prefix,
    allowFrom: [...settings.commands.allowFrom],
  };
  resetMailer();
}

export function loadSettings(): void {
  const path = config.settingsPath;
  if (!existsSync(path)) {
    logger.info("未找到 settings.json，使用 .env 預設值", { path });
    return;
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const parsed = settingsSchema.partial().safeParse(raw);
    if (!parsed.success) {
      logger.error("settings.json 格式錯誤，已忽略", {
        issues: parsed.error.issues.map((issue) => issue.path.join(".")),
      });
      return;
    }

    const base = currentSettings();
    const data = parsed.data;
    apply({
      ...base,
      ...data,
      templates: data.templates ?? base.templates,
      flexTemplates: data.flexTemplates ?? base.flexTemplates,
      apiTokens: data.apiTokens ?? base.apiTokens,
      forward: data.forward ?? base.forward,
      send: { ...base.send, ...(data.send ?? {}) },
      rateLimit: { ...base.rateLimit, ...(data.rateLimit ?? {}) },
      line: { ...base.line, ...(data.line ?? {}) },
      smtp: { ...base.smtp, ...(data.smtp ?? {}) },
      autoReply: { ...base.autoReply, ...(data.autoReply ?? {}) },
      commands: { ...base.commands, ...(data.commands ?? {}) },
    });
    logger.info("已載入 settings.json", { path });
  } catch (error) {
    logger.error("讀取 settings.json 失敗，已忽略", { error: String(error) });
  }
}

export function saveSettings(input: unknown): EditableSettings {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`設定驗證失敗：${details}`);
  }

  apply(parsed.data);
  writeFileSync(config.settingsPath, JSON.stringify(parsed.data, null, 2), "utf8");
  logger.info("設定已更新並儲存", { path: config.settingsPath });
  return parsed.data;
}
