import type { Server } from "node:http";
import { config } from "./config.js";
import { initLogger, logger } from "./logger.js";
import { loadSettings } from "./settings.js";
import { initAuth } from "./middleware/session.js";
import { initMessages } from "./messages.js";
import { initStats } from "./stats.js";
import { loadSkills } from "./skills/index.js";
import { setState } from "./state.js";
import { LineService } from "./line/client.js";
import { createServer } from "./webhook/server.js";
import { startHealthMonitor } from "./monitor/token.js";

function installProcessGuards(): void {
  process.on("unhandledRejection", (reason) => {
    logger.error("未處理的 Promise rejection（已記錄，服務繼續）", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });

  process.on("uncaughtException", (error) => {
    logger.error("未捕捉的例外（已記錄，服務繼續）", {
      error: error.message,
      at: error.stack?.split("\n")[1]?.trim(),
    });
  });
}

async function main(): Promise<void> {
  installProcessGuards();
  initLogger();
  loadSettings();
  initAuth();
  initMessages();
  initStats();
  await loadSkills();
  logger.info("服務啟動中", { port: config.port });

  const line = new LineService();
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

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("收到關閉訊號，正在關閉", { signal });

    monitor.stop();
    line.stopListening();
    line.stopQueue();

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
