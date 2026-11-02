import { config } from "../config.js";
import { logger } from "../logger.js";
import { getService } from "./services.js";
import type { Platform } from "./types.js";

/**
 * P3 跨平台備援：主平台送出失敗時，改走第二順位平台發送（同一個人）。
 * 對應關係用「名稱」對照（各平台的目標 id 不同，只能靠人名／暱稱配對），
 * 配不到就不備援（寧可不發，也不要發給錯的人）。
 */

export interface FallbackTarget {
  platform: Platform;
  chat: string;
  /** 對方在那個平台的暱稱／名稱。 */
  name: string;
}

/** 依設定的備援順序（不含目前平台）。 */
export function fallbackOrder(current: string): Platform[] {
  const configured = config.fallbackPlatforms;
  const known: Platform[] = ["line", "telegram", "whatsapp", "teams", "discord"];
  return configured.filter((p): p is Platform => known.includes(p as Platform) && p !== current);
}

/**
 * 找出可用的備援目標：在備援平台裡，用對方名稱（或對話 id）找到對應的聊天。
 * 找不到回 null（不亂發）。
 */
export function findFallbackTarget(current: string, chat: string, fromName: string): FallbackTarget | null {
  const name = (fromName || "").trim();
  for (const platform of fallbackOrder(current)) {
    const svc = getService(platform);
    if (!svc) continue;
    let targets: Array<{ name: string; id: string }> = [];
    try {
      targets = svc.listTargets();
    } catch {
      continue;
    }
    // 名字完全相同優先
    if (name) {
      const byName = targets.find((t) => t.name === name);
      if (byName) return { platform, chat: byName.id, name: byName.name };
    }
    // 其次：兩個平台的對話 id 相同（少見但有）
    const byId = targets.find((t) => t.id === chat);
    if (byId) return { platform, chat: byId.id, name: byId.name };
  }
  return null;
}

/**
 * 送出訊息；主平台失敗就改走備援平台（在訊息前標示實際送出管道）。
 * primarySend 是主平台的送出動作（各平台的 reply 語意不同，由呼叫端提供）。
 * 回傳實際使用的平台（沒送出去回 null）。
 */
export async function sendWithFallback(
  primaryPlatform: string,
  primaryChat: string,
  text: string,
  fromName: string,
  primarySend: () => Promise<void>,
): Promise<string | null> {
  try {
    await primarySend();
    return primaryPlatform;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("主平台送出失敗，嘗試備援平台", { platform: primaryPlatform, error: message });
    const target = findFallbackTarget(primaryPlatform, primaryChat, fromName);
    if (!target) {
      // 沒有備援目標 → 原樣拋回（呼叫端照舊知道這次失敗，不會被吃掉）。
      logger.warn("沒有可用的備援目標（名稱對不到就不亂發）", { platform: primaryPlatform });
      throw error;
    }
    const svc = getService(target.platform);
    if (!svc) throw error;
    const note = `（${primaryPlatform} 送出失敗，改由 ${target.platform} 送出）\n${text}`;
    try {
      await svc.sendAdvanced([{ to: target.chat, text: note }]);
      logger.info("已改由備援平台送出", { from: primaryPlatform, to: target.platform, name: target.name });
      return target.platform;
    } catch (fallbackError) {
      logger.error("備援平台送出也失敗", {
        platform: target.platform,
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
      // 備援也失敗 → 仍以主要平台的錯誤為準（呼叫端看得到真正的原因）。
      throw error;
    }
  }
}
