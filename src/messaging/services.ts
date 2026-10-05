import type { IMessagingService, Platform } from "./types.js";
import { logger } from "../logger.js";

const services = new Map<Platform, IMessagingService>();

/** 註冊一個平台服務（index.ts 啟動時呼叫；測試可重複註冊覆蓋）。 */
export function registerService(service: IMessagingService): void {
  // D6：同一個 platform key 重複註冊會靜默覆蓋，明確記一筆以免除錯困難。
  if (services.has(service.platform)) {
    logger.error("重複註冊平台服務（舊的已被覆蓋）", { platform: service.platform });
  }
  services.set(service.platform, service);
}

export function getService(platform: Platform): IMessagingService | undefined {
  return services.get(platform);
}

export function listServices(): IMessagingService[] {
  return [...services.values()];
}
