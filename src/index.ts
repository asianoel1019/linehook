import type { Server } from "node:http";
import { config } from "./config.js";
import { initLogger, logger } from "./logger.js";
import { loadSettings } from "./settings.js";
import { initAuth } from "./middleware/session.js";
import { initMessages } from "./messages.js";
import { initStats } from "./stats.js";
import { initTokenStats } from "./token-stats.js";
import { loadSkills } from "./skills/index.js";
import { setState } from "./state.js";
import { LineService } from "./line/client.js";
import { TelegramService } from "./telegram/client.js";
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
  initLogger();
  loadSettings();
  initAuth();
  initMessages();
  initStats();
  initTokenStats();
  await loadSkills();
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

  const monitor = startHealthMonitor(line);

  void line.init().catch((error) => {
    logger.error("LINE 登入失敗，可至狀態頁查看", { error: String(error) });
    setState({ status: "需人工", lastError: String(error) });
  });

  if (telegram) {
    void telegram.init().catch((error) => {
      logger.error("Telegram 初始化失敗", { error: String(error) });
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
