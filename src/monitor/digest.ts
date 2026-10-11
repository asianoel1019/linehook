/** 每日營運摘要：彙整平台健康、發送統計、死信、技能觸發與 LLM 成本，走告警通道寄送。 */

import { config } from "../config.js";
import { logger } from "../logger.js";
import { formatInTz, zonedTimeToMs } from "../time.js";
import { getStats } from "../stats.js";
import { countDeadLetters } from "../deadletter.js";
import { llmUsage } from "../llm-usage.js";
import { getCounters } from "../metrics.js";
import { listServices } from "../messaging/services.js";
import { sendAlert } from "../notify/alert.js";
import type { IMessagingService } from "../messaging/types.js";

export interface DigestSection {
  title: string;
  lines: string[];
}

export interface DigestInput {
  /** 平台健康檢查結果（平台 → 是否健康）。 */
  platformHealth: Array<{ platform: string; ok: boolean }>;
  /** 昨日發送統計。 */
  yesterday: { total: number; ok: number; fail: number };
  deadletters: number;
  /** 技能執行次數（skill → {run, failed}）。 */
  skills: Array<{ skill: string; run: number; failed: number }>;
  /** LLM 用量（關閉時傳 null）。 */
  llm: { calls: number; tokens: number; costUsd: number | null } | null;
}

/** 組裝摘要文字（純函式，測試用；成對的 input 缺欄位不會爆）。 */
export function composeDigestText(input: DigestInput, dateLabel: string): string {
  const lines: string[] = [];
  lines.push(`📊 IM Webhook 每日摘要（${dateLabel}）`);

  const health = input.platformHealth ?? [];
  if (health.length > 0) {
    const bad = health.filter((h) => !h.ok);
    lines.push(
      `平台：${bad.length === 0 ? "全部正常" : `${bad.map((h) => h.platform).join("、")} 異常`}（共 ${health.length} 個）`,
    );
  } else {
    lines.push("平台：無啟用中的通訊平台");
  }

  const y = input.yesterday ?? { total: 0, ok: 0, fail: 0 };
  const rate = y.total > 0 ? Math.round((y.ok / y.total) * 1000) / 10 : 0;
  lines.push(`發送：${y.total} 則（成功 ${y.ok}・失敗 ${y.fail}・成功率 ${rate}%）`);

  lines.push(`死信：${input.deadletters ?? 0} 筆`);

  const skills = (input.skills ?? [])
    .filter((s) => s.run > 0)
    .sort((a, b) => b.run - a.run)
    .slice(0, 5);
  if (skills.length > 0) {
    lines.push(
      `技能 TOP ${skills.length}：${skills.map((s) => `${s.skill} ${s.run}${s.failed > 0 ? `（失敗 ${s.failed}）` : ""}`).join("、")}`,
    );
  } else {
    lines.push("技能：昨日無觸發紀錄");
  }

  if (input.llm) {
    const cost = input.llm.costUsd !== null ? `・約 $${input.llm.costUsd}` : "";
    lines.push(`LLM：${input.llm.calls} 次呼叫・${input.llm.tokens.toLocaleString("en-US")} tokens${cost}`);
  }

  lines.push(`時間：${formatInTz(new Date(), config.timezone)}`);
  return lines.join("\n");
}

/** 平台健康快照（並行；單一平台拋錯視為不健康）。 */
async function probeHealth(services: IMessagingService[]): Promise<Array<{ platform: string; ok: boolean }>> {
  return Promise.all(
    services.map(async (svc) => {
      try {
        return { platform: svc.platform, ok: await svc.healthCheck() };
      } catch {
        return { platform: svc.platform, ok: false };
      }
    }),
  );
}

/** 由 metrics 聚合技能執行次數與失敗次數。 */
function skillStats(): Array<{ skill: string; run: number; failed: number }> {
  const agg = new Map<string, { run: number; failed: number }>();
  for (const counter of getCounters()) {
    if (counter.name !== "skill_exec_total") continue;
    const skill = counter.labels.skill ?? "unknown";
    const entry = agg.get(skill) ?? { run: 0, failed: 0 };
    entry.run += counter.value;
    if (counter.labels.result === "error") entry.failed += counter.value;
    agg.set(skill, entry);
  }
  return [...agg.entries()].map(([skill, v]) => ({ skill, ...v }));
}

/** 昨日（設定時區）的發送統計。 */
function yesterdayStats(): { total: number; ok: number; fail: number } {
  const prev = formatInTz(new Date(Date.now() - 86_400_000), config.timezone).slice(0, 10);
  const days = getStats(2).days;
  const hit = days.find((d) => d.date === prev) ?? days[days.length - 1];
  return { total: hit?.total ?? 0, ok: hit?.ok ?? 0, fail: hit?.fail ?? 0 };
}

export interface DigestHandle {
  stop(): void;
  /** 立即組裝並寄送（供設定頁測試與手動觸發）。 */
  sendNow(): Promise<{ ok: boolean; text: string }>;
  /** 下次寄送時間（ISO）；未啟用回 null。 */
  nextRunAt(): string | null;
}

let active: DigestHandle | null = null;

/** 啟動每日摘要排程（DIGEST_ENABLED=false 时不排程，但仍可手動寄送）。 */
export function startDigest(): DigestHandle {
  if (active) return active;
  active = createDigest();
  return active;
}

/** 取得（必要時建立）摘要 handle；供 HTTP route 手動觸發。 */
export function getDigest(): DigestHandle {
  return startDigest();
}

function createDigest(): DigestHandle {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const nextAt = (): number | null => {
    const m = /^(\d{1,2})[:：](\d{2})$/.exec(config.digest.at.trim());
    if (!m) return null;
    const now = new Date();
    const today = zonedTimeToMs(
      {
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
        hour: Number(m[1]),
        minute: Number(m[2]),
      },
      config.timezone,
    );
    return today > Date.now() ? today : today + 86_400_000;
  };

  const sendNow = async (): Promise<{ ok: boolean; text: string }> => {
    try {
      const [health, usage] = await Promise.all([probeHealth(listServices()), Promise.resolve(llmUsage())]);
      const text = composeDigestText(
        {
          platformHealth: health,
          yesterday: yesterdayStats(),
          deadletters: countDeadLetters(),
          skills: skillStats(),
          llm: config.digest.includeLlm
            ? {
                calls: usage.rows.reduce((a, r) => a + r.calls, 0),
                tokens: usage.totalTokens,
                costUsd: usage.totalCostUsd,
              }
            : null,
        },
        formatInTz(new Date(Date.now() - 86_400_000), config.timezone).slice(0, 10),
      );
      // sendAlert 回每條通道結果：未設任何通道或全部失敗都不算寄送成功（由呼叫端提示）。
      const outcomes = await sendAlert("[IM Webhook] 每日摘要", text);
      return { ok: outcomes.some((o) => o.ok), text };
    } catch (error) {
      logger.error("每日摘要寄送失敗", { error: String(error) });
      return { ok: false, text: `摘要組裝失敗：${error instanceof Error ? error.message : String(error)}` };
    }
  };

  const schedule = (): void => {
    if (stopped || !config.digest.enabled) return;
    const at = nextAt();
    if (at === null) {
      logger.warn("每日摘要時間格式錯誤", { at: config.digest.at });
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = null;
        void sendNow().then(schedule);
      },
      Math.max(0, at - Date.now()),
    );
    timer.unref?.();
  };

  schedule();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    sendNow,
    nextRunAt(): string | null {
      const at = nextAt();
      return at === null ? null : new Date(at).toISOString();
    },
  };
}
