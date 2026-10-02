import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { config, DEVICES } from "./config.js";
import { logger } from "./logger.js";
import { resetMailer } from "./notify/mailer.js";

const settingsSchema = z.object({
  allowedIps: z.array(z.string()).default([]),
  hmacSecret: z.string().trim().default(""),
  hmacEnabled: z.boolean().default(true),
  hmacMaxSkewSec: z.coerce.number().int().nonnegative().default(300),
  webhookToken: z.string().trim().default(""),
  webhookTokenEnabled: z.boolean().default(true),
  apiToken: z.string().trim().default(""),
  apiTokenEnabled: z.boolean().default(true),
  language: z.enum(["zh", "en", "ja"]).default("zh"),
  timezone: z.string().default("Asia/Taipei"),
  apiTokens: z
    .array(
      z.object({
        name: z.string().default(""),
        token: z.string().trim().default(""),
        scopes: z.array(z.enum(["read", "send", "admin"])).default(["send"]),
      }),
    )
    .default([]),
  statusPublic: z.boolean().default(true),
  adminPrivateOnly: z.boolean().default(false),
  targets: z.record(z.string(), z.string()).default({}),
  telegram: z
    .object({
      enabled: z.boolean().default(false),
      botToken: z.string().trim().default(""),
      secretToken: z.string().trim().default(""),
      webhookUrl: z.string().trim().default(""),
      targets: z.record(z.string(), z.string()).default({}),
    })
    .default({ enabled: false, botToken: "", secretToken: "", webhookUrl: "", targets: {} }),
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
  replyMaxChars: z.coerce.number().int().nonnegative().default(4000),
  line: z.object({
    device: z.enum(DEVICES).default("DESKTOPWIN"),
    deviceName: z.string().default("IM Webhook"),
    modelName: z.string().default("IM Webhook"),
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
  assistant: z
    .object({
      enabled: z.boolean().default(false),
      name: z.string().default("阿寶"),
    })
    .default({ enabled: false, name: "阿寶" }),
  skills: z
    .array(
      z.object({
        id: z.string().default(""),
        enabled: z.boolean().default(false),
        trigger: z.string().default(""),
        config: z.record(z.string(), z.string()).default({}),
      }),
    )
    .default([]),
});

export type EditableSettings = z.infer<typeof settingsSchema>;

export function currentSettings(): EditableSettings {
  return {
    allowedIps: [...config.allowedIps],
    hmacSecret: config.hmacSecret,
    hmacEnabled: config.hmacEnabled,
    hmacMaxSkewSec: config.hmacMaxSkewSec,
    webhookToken: config.webhookToken,
    webhookTokenEnabled: config.webhookTokenEnabled,
    apiToken: config.apiToken,
    apiTokenEnabled: config.apiTokenEnabled,
    language: config.language,
    timezone: config.timezone,
    apiTokens: config.apiTokens.map((item) => ({ name: item.name, token: item.token, scopes: [...item.scopes] })),
    statusPublic: config.statusPublic,
    adminPrivateOnly: config.adminPrivateOnly,
    targets: { ...config.targets },
    telegram: {
      enabled: config.telegram.enabled,
      botToken: config.telegram.botToken,
      secretToken: config.telegram.secretToken,
      webhookUrl: config.telegram.webhookUrl,
      targets: { ...config.telegram.targets },
    },
    templates: config.templates.map((template) => ({ ...template })),
    flexTemplates: config.flexTemplates.map((template) => ({ ...template })),
    healthCheckIntervalSec: config.healthCheckIntervalSec,
    logLimit: config.logLimit,
    logMaxBytes: config.logMaxBytes,
    logMaxFiles: config.logMaxFiles,
    messagesPersist: config.messagesPersist,
    send: { ...config.send },
    rateLimit: { ...config.rateLimit },
    replyMaxChars: config.replyMaxChars,
    line: {
      device: config.line.device,
      deviceName: config.line.deviceName,
      modelName: config.line.modelName,
    },
    smtp: { ...config.smtp },
    forward: config.forward.map((rule) => ({ ...rule })),
    commands: {
      enabled: config.commands.enabled,
      prefix: config.commands.prefix,
      allowFrom: [...config.commands.allowFrom],
    },
    assistant: {
      enabled: config.assistant.enabled,
      name: config.assistant.name,
    },
    skills: config.skills.map((skill) => ({
      id: skill.id,
      enabled: skill.enabled,
      trigger: skill.trigger,
      config: { ...skill.config },
    })),
  };
}

function apply(settings: EditableSettings): void {
  config.allowedIps = settings.allowedIps;
  config.hmacSecret = settings.hmacSecret;
  config.hmacEnabled = settings.hmacEnabled;
  config.hmacMaxSkewSec = settings.hmacMaxSkewSec;
  config.webhookToken = settings.webhookToken;
  config.webhookTokenEnabled = settings.webhookTokenEnabled;
  config.apiToken = settings.apiToken;
  config.apiTokenEnabled = settings.apiTokenEnabled;
  config.language = settings.language;
  config.timezone = settings.timezone;
  config.apiTokens = settings.apiTokens.map((item) => ({
    name: item.name,
    token: item.token,
    scopes: [...item.scopes],
  }));
  config.statusPublic = settings.statusPublic;
  config.adminPrivateOnly = settings.adminPrivateOnly;
  config.targets = settings.targets;
  config.telegram = {
    enabled: settings.telegram.enabled,
    botToken: settings.telegram.botToken,
    secretToken: settings.telegram.secretToken,
    webhookUrl: settings.telegram.webhookUrl,
    targets: { ...settings.telegram.targets },
  };
  config.templates = settings.templates.map((template) => ({ ...template }));
  config.flexTemplates = settings.flexTemplates.map((template) => ({ ...template }));
  config.healthCheckIntervalSec = settings.healthCheckIntervalSec;
  config.logLimit = settings.logLimit;
  config.logMaxBytes = settings.logMaxBytes;
  config.logMaxFiles = settings.logMaxFiles;
  config.messagesPersist = settings.messagesPersist;
  config.send = { ...settings.send };
  config.rateLimit = { ...settings.rateLimit };
  config.replyMaxChars = settings.replyMaxChars;
  config.line.device = settings.line.device;
  config.line.deviceName = settings.line.deviceName;
  config.line.modelName = settings.line.modelName;
  config.smtp = { ...settings.smtp };
  config.forward = settings.forward.map((rule) => ({ ...rule }));
  config.commands = {
    enabled: settings.commands.enabled,
    prefix: settings.commands.prefix,
    allowFrom: [...settings.commands.allowFrom],
  };
  config.assistant = {
    enabled: settings.assistant.enabled,
    name: settings.assistant.name,
  };
  config.skills = settings.skills.map((skill) => ({
    id: skill.id,
    enabled: skill.enabled,
    trigger: skill.trigger,
    config: { ...skill.config },
  }));
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
      skills: data.skills ?? base.skills,
      send: { ...base.send, ...(data.send ?? {}) },
      rateLimit: { ...base.rateLimit, ...(data.rateLimit ?? {}) },
      line: { ...base.line, ...(data.line ?? {}) },
      smtp: { ...base.smtp, ...(data.smtp ?? {}) },
      commands: { ...base.commands, ...(data.commands ?? {}) },
      assistant: { ...base.assistant, ...(data.assistant ?? {}) },
      telegram: { ...base.telegram, ...(data.telegram ?? {}) },
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
