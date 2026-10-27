import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { listServices } from "./messaging/services.js";
import { listSkills } from "./skills/index.js";
import { findTriggerConflicts } from "./messaging/dispatch.js";
import { getOutboundBlocked, getOutboundStats, isHostDegraded } from "./net.js";
import { isLang, tr } from "./i18n.js";

/**
 * P1-1 首次設定健檢：把「部署是否正確」收斂成一頁檢查清單，
 * 每項給現況（detail）＋怎麼修（fix）。資料走既有零件
 *（healthCheck、findTriggerConflicts、listScheduled、inbound 落檔），不重複造。
 */

export interface CheckItem {
  id: string;
  ok: boolean;
  name: string;
  detail: string;
  fix: string;
}

export interface CheckupReport {
  at: string;
  items: CheckItem[];
}

async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function lang(): "zh" | "en" | "ja" {
  const l = config.language;
  return isLang(l) ? l : "zh";
}

async function checkPlatforms(): Promise<CheckItem[]> {
  const services = listServices();
  if (services.length === 0) {
    return [{ id: "platforms", ok: false, name: tr(lang(), "ck_platforms"), detail: tr(lang(), "ck_no_platform"), fix: tr(lang(), "fix_platform") }];
  }
  const items: CheckItem[] = [];
  for (const svc of services) {
    try {
      const ok = await withTimeout(Promise.resolve().then(() => svc.healthCheck()), 10_000);
      items.push({
        id: `platform:${svc.platform}`,
        ok: ok === true,
        name: `${tr(lang(), "ck_platforms")}（${svc.platform}）`,
        detail: ok === true ? "OK" : ok === null ? tr(lang(), "ck_timeout") : tr(lang(), "ck_unhealthy"),
        fix: tr(lang(), "fix_platform"),
      });
    } catch (error) {
      items.push({
        id: `platform:${svc.platform}`,
        ok: false,
        name: `${tr(lang(), "ck_platforms")}（${svc.platform}）`,
        detail: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
        fix: tr(lang(), "fix_platform"),
      });
    }
  }
  return items;
}

function checkConflicts(): CheckItem {
  const input = listSkills()
    .filter((def) => def.triggerMode !== "any")
    .map((def) => {
      const entry = config.skills.find((s) => s.id === def.id);
      return {
        id: def.id,
        enabled: entry?.enabled ?? false,
        words: [(entry?.trigger || def.defaultTrigger).trim(), ...(def.triggerAliases ?? [])],
      };
    });
  const conflicts = findTriggerConflicts(input);
  return {
    id: "conflicts",
    ok: conflicts.length === 0,
    name: tr(lang(), "ck_conflicts"),
    detail: conflicts.length === 0 ? "OK" : conflicts.map((c) => `「${c.word}」：${c.owners.join(" ↔ ")}`).join("；"),
    fix: tr(lang(), "fix_conflicts"),
  };
}

function checkScheduler(): CheckItem {
  try {
    let jobs = 0;
    let pending = 0;
    const plats: string[] = [];
    for (const svc of listServices()) {
      const list = svc.listScheduled();
      jobs += list.length;
      plats.push(svc.platform);
      try {
        pending += svc.getQueueStats().pending;
      } catch {
        // 單一平台取不到不拖累整項
      }
    }
    return {
      id: "scheduler",
      ok: true,
      name: tr(lang(), "ck_scheduler"),
      detail: `${plats.join("、") || "—"}：${jobs} ${tr(lang(), "ck_jobs")}，${tr(lang(), "ck_queue")} ${pending}`,
      fix: tr(lang(), "fix_scheduler"),
    };
  } catch (error) {
    return {
      id: "scheduler",
      ok: false,
      name: tr(lang(), "ck_scheduler"),
      detail: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
      fix: tr(lang(), "fix_scheduler"),
    };
  }
}

function checkStorage(): CheckItem {
  try {
    const dir = dirname(config.schedulesPath);
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.writetest-${process.pid}`);
    writeFileSync(probe, "ok", "utf8");
    const back = readFileSync(probe, "utf8");
    rmSync(probe, { force: true });
    const ok = back === "ok";
    return {
      id: "storage",
      ok,
      name: tr(lang(), "ck_storage"),
      detail: dir,
      fix: tr(lang(), "fix_storage"),
    };
  } catch (error) {
    return {
      id: "storage",
      ok: false,
      name: tr(lang(), "ck_storage"),
      detail: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
      fix: tr(lang(), "fix_storage"),
    };
  }
}

function checkAlert(): CheckItem {
  const smtp = config.smtp?.host?.trim();
  const hooks = config.alert?.webhookUrls ?? [];
  const parts: string[] = [];
  if (smtp) parts.push(`Email（${smtp}）`);
  if (hooks.length > 0) parts.push(`${hooks.length} ${tr(lang(), "ck_hook")}`);
  return {
    id: "alert",
    ok: parts.length > 0,
    name: tr(lang(), "ck_alert"),
    detail: parts.length > 0 ? parts.join("、") : tr(lang(), "ck_no_alert"),
    fix: tr(lang(), "fix_alert"),
  };
}

function checkOutbound(): CheckItem {
  const enforcing = config.outboundEnforce;
  const listed = config.outboundAllowlist.length > 0 || config.outboundBlocklist.length > 0;
  const mode = !listed ? tr(lang(), "ck_policy_off") : enforcing ? tr(lang(), "ck_policy_on") : tr(lang(), "ck_policy_watch");
  const blocked = getOutboundBlocked();
  const degraded = getOutboundStats()
    .filter((s) => isHostDegraded(s.host))
    .map((s) => s.host);
  const parts = [mode];
  if (blocked.length > 0) parts.push(`${tr(lang(), "ck_blocked")}: ${blocked.map((b) => `${b.host}×${b.count}`).join("、")}`);
  if (degraded.length > 0) parts.push(`${tr(lang(), "ck_degraded")}: ${degraded.join("、")}`);
  return {
    id: "outbound",
    ok: true,
    name: tr(lang(), "ck_outbound"),
    detail: parts.join("；"),
    fix: tr(lang(), "fix_outbound"),
  };
}

function checkInbound(): CheckItem {
  const plats = listServices().map((s) => s.platform);
  const lastByPlatform = new Map<string, string>();
  try {
    if (existsSync(config.inboundQueuePath)) {
      const lines = readFileSync(config.inboundQueuePath, "utf8").split("\n").filter(Boolean);
      for (const line of lines.slice(-300)) {
        try {
          const r = JSON.parse(line) as { time?: unknown; platform?: unknown };
          if (typeof r.time === "string" && typeof r.platform === "string") lastByPlatform.set(r.platform, r.time);
        } catch {
          // 壞行跳過
        }
      }
    }
  } catch (error) {
    logger.warn("健檢讀取進站紀錄失敗", { error: String(error) });
  }
  const fmt = (iso: string): string => iso.slice(0, 16).replace("T", " ");
  const unseen = plats.filter((p) => !lastByPlatform.has(p));
  const detail =
    plats.length === 0
      ? tr(lang(), "ck_no_platform")
      : plats.map((p) => `${p}：${lastByPlatform.has(p) ? fmt(lastByPlatform.get(p) as string) : tr(lang(), "ck_no_inbound")}`).join("；");
  return {
    id: "inbound",
    ok: unseen.length === 0,
    name: tr(lang(), "ck_inbound"),
    detail,
    fix: tr(lang(), "fix_inbound"),
  };
}

/** 跑完全部檢查（單項逾時／例外只壞自己，不拖累整份報告）。 */
export async function runCheckup(): Promise<CheckupReport> {
  const items: CheckItem[] = [];
  for (const fn of [checkPlatforms]) {
    try {
      items.push(...(await fn()));
    } catch (error) {
      items.push({
        id: "platforms",
        ok: false,
        name: tr(lang(), "ck_platforms"),
        detail: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
        fix: tr(lang(), "fix_platform"),
      });
    }
  }
  for (const fn of [checkConflicts, checkScheduler, checkStorage, checkAlert, checkOutbound, checkInbound]) {
    try {
      items.push(fn());
    } catch (error) {
      items.push({
        id: "unknown",
        ok: false,
        name: fn.name,
        detail: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
        fix: "",
      });
    }
  }
  return { at: new Date().toISOString(), items };
}
