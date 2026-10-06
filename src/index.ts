import type { Server } from "node:http";
import { config } from "./config.js";
import { initLogger, logger } from "./logger.js";
import { loadSettings } from "./settings.js";
import { initStore, closeStore } from "./store/index.js";
import { webhookAuthEnabled } from "./middleware/hmac.js";
import { initAuth } from "./middleware/session.js";
import { initMessages } from "./messages.js";
import { initStats } from "./stats.js";
import { initTokenStats } from "./token-stats.js";
import { loadSkills } from "./skills/index.js";
import { sweepCache } from "./skills/cache.js";
import { pruneMessages } from "./messages.js";
import { pruneUploads } from "./uploads.js";
import { countPersistedInbound } from "./messaging/inbox.js";
import { setState } from "./state.js";
import { LineService } from "./line/client.js";
import { TelegramService } from "./telegram/client.js";
import { WhatsAppService } from "./whatsapp/client.js";
import { WhatsAppWebService } from "./whatsapp/web-client.js";
import { TeamsService } from "./teams/client.js";
import { LineOfficialService } from "./line-official/client.js";
import { DiscordService } from "./discord/client.js";
import { registerService } from "./messaging/services.js";
import { createServer } from "./webhook/server.js";
import { startHealthMonitor } from "./monitor/token.js";

function installProcessGuards(): void {
  process.on("unhandledRejection", (reason) => {
    logger.error("未處理的 Promise rejection（即將結束，由 supervisor 重啟）", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
    process.exit(1);
  });

  process.on("uncaughtException", (error) => {
    logger.error("未捕捉的例外（即將結束，由 supervisor 重啟）", {
      error: error.message,
      at: error.stack?.split("\n")[1]?.trim(),
    });
    process.exit(1);
  });
}

async function main(): Promise<void> {
  installProcessGuards();
  // D5：單一行程是硬性限制（行程內狀態＋長連線不可共享）；PM2/cluster
  // 若啟動多實例，直接報錯退出，避免限流與重播保護靜默失效。
  if (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== "0") {
    console.error("只支援單一行程執行（NODE_APP_INSTANCE 必須為 0），拒絕啟動");
    process.exit(1);
  }
  initLogger();
  loadSettings();
  // B1：三種 webhook 驗證全關時直接拒絕啟動，避免靜默變成公開端點。
  // 明確要開放測試時，設 ALLOW_OPEN_WEBHOOK=true。
  if (!webhookAuthEnabled() && !config.allowOpenWebhook) {
    logger.error(
      "webhook 未啟用任何驗證（HMAC/Token/API Token 皆未設定），拒絕啟動；" +
      "請至少設定其中一種，或以 ALLOW_OPEN_WEBHOOK=true 明確允許開放模式",
    );
    process.exit(1);
  }
  initAuth();
  // A6/NEXT3：統一儲存層先開（sqlite 首次開機會把既有 JSONL 遷移）。
  initStore();
  initMessages();
  initStats();
  initTokenStats();
  await loadSkills();
  sweepCache();
  setInterval(() => sweepCache(), 24 * 60 * 60 * 1000).unref?.();
  // I1/I2：依保留政策修剪訊息與上傳檔。
  pruneMessages();
  setInterval(() => pruneMessages(), 24 * 60 * 60 * 1000).unref?.();
  pruneUploads();
  setInterval(() => pruneUploads(), 24 * 60 * 60 * 1000).unref?.();
  const pendingInbound = countPersistedInbound();
  if (pendingInbound > 0) {
    logger.warn("落地收訊檔尚有未處理紀錄（上次崩潰可能遺失處理）", {
      path: config.inboundQueuePath,
      count: pendingInbound,
    });
  }
  logger.info("服務啟動中", { port: config.port });

  const line = new LineService();
  registerService(line);

  // Telegram 與 LINE 可同時上線；未設定 botToken 時不註冊（/webhook/tg、/tg/update 回 503）。
  let telegram: TelegramService | null = null;
  if (config.telegram.enabled && config.telegram.botToken.trim()) {
    telegram = new TelegramService();
    registerService(telegram);
    logger.info("Telegram 已啟用");
  }

  // WhatsApp 同理；依 mode 選擇 Cloud API 或個人帳號（WhatsApp Web）。
  // Cloud 需 accessToken + phoneNumberId；Web 需 enabled 即可（QR 登入）。
  let whatsapp: WhatsAppService | WhatsAppWebService | null = null;
  if (config.whatsapp.enabled) {
    if (config.whatsapp.mode === "web") {
      whatsapp = new WhatsAppWebService();
      registerService(whatsapp);
      logger.info("WhatsApp 已啟用（個人帳號 / Web 模式）");
    } else if (config.whatsapp.accessToken.trim() && config.whatsapp.phoneNumberId.trim()) {
      whatsapp = new WhatsAppService();
      registerService(whatsapp);
      logger.info("WhatsApp 已啟用（Cloud API 模式）");
    } else {
      logger.warn("WhatsApp 已啟用但模式為 cloud 且未設定 accessToken / phoneNumberId，略過");
    }
  }

  // Teams：需 appId + appPassword（Entra client-credentials）。
  let teams: TeamsService | null = null;
  if (config.teams.enabled && config.teams.appId.trim() && config.teams.appPassword.trim()) {
    teams = new TeamsService();
    registerService(teams);
    logger.info("Teams 已啟用");
  }

  // Discord：Gateway 長連線（非 webhook）；需 enabled + botToken。
  let discord: DiscordService | null = null;
  if (config.discord.enabled && config.discord.botToken.trim()) {
    discord = new DiscordService();
    registerService(discord);
    logger.info("Discord 已啟用");
  }

  // E2：LINE 官方 Messaging API（與 selfbot 的 LINE 雙軌並存）；需 enabled + channel access token。
  let lineOfficial: LineOfficialService | null = null;
  if (config.lineOfficial.enabled && config.lineOfficial.channelAccessToken.trim()) {
    lineOfficial = new LineOfficialService();
    registerService(lineOfficial);
    logger.info("LINE 官方已啟用（Messaging API）");
  }

  const app = createServer(line);

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(config.port, () => {
      logger.info("Webhook 監聽中", {
        url: `http://localhost:${config.port}/webhook`,
      });
      logger.info("狀態頁", { url: `http://localhost:${config.port}/status` });
      resolve(instance);
    });
  });

  const monitor = startHealthMonitor();

  void line.init().catch((error) => {
    logger.error("LINE 登入失敗，可至狀態頁查看", { error: String(error) });
    setState({ status: "需人工", lastError: String(error) });
  });

  if (telegram) {
    void telegram.init().catch((error) => {
      logger.error("Telegram 初始化失敗", { error: String(error) });
    });
  }

  if (whatsapp) {
    void whatsapp.init().catch((error) => {
      logger.error("WhatsApp 初始化失敗", { error: String(error) });
    });
  }

  if (teams) {
    void teams.init().catch((error) => {
      logger.error("Teams 初始化失敗", { error: String(error) });
    });
  }

  if (discord) {
    void discord.init().catch((error) => {
      logger.error("Discord 初始化失敗", { error: String(error) });
    });
  }

  if (lineOfficial) {
    void lineOfficial.init().catch((error) => {
      logger.error("LINE 官方初始化失敗", { error: String(error) });
    });
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("收到關閉訊號，正在關閉", { signal });

    monitor.stop();
    line.stopListening();
    line.stopQueue();
    telegram?.stopQueue();
    whatsapp?.stopQueue();
    teams?.stopQueue();
    discord?.stopQueue();
    lineOfficial?.stopListening();
    lineOfficial?.stopQueue();
    closeStore();

    const force = setTimeout(() => {
      logger.warn("關閉逾時，強制結束");
      process.exit(1);
    }, 10_000);
    force.unref();

    server.close(() => {
      logger.info("已關閉");
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("啟動失敗", error);
  process.exit(1);
});
