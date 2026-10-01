import type { IMessagingService, Platform } from "./types.js";

const services = new Map<Platform, IMessagingService>();

/** 註冊一個平台服務（index.ts 啟動時呼叫；測試可重複註冊覆蓋）。 */
export function registerService(service: IMessagingService): void {
  services.set(service.platform, service);
}

export function getService(platform: Platform): IMessagingService | undefined {
  return services.get(platform);
}

export function listServices(): IMessagingService[] {
  return [...services.values()];
}
