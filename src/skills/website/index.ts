import { connect } from "node:tls";
import { fetchWithLimits } from "@lw/net";
import type { SkillContext, SkillDefinition, SkillHealth, SkillTaskContext } from "@lw/skills/types";
import { describeWatch } from "@lw/skills/watch";

const TASK = "monitor";
const MAX_SITES = 10;
const UA = "Mozilla/5.0 (compatible; ImHook/1.0)";

export interface SiteState {
  /** 上次是否正常（2xx/3xx）。 */
  ok: boolean;
  code: number;
  checkedAt: number;
}

export interface CertState {
  /** 距到期天數。 */
  days: number;
  /** 是否已推播過到期警告（恢復正常後重置）。 */
  warned: boolean;
}

interface MonitorState {
  sites: string[];
  status: Record<string, SiteState>;
  cert: Record<string, CertState>;
}

/** 判斷 HTTP 狀態碼是否視為正常。 */
export function isOkCode(code: number): boolean {
  return code >= 200 && code < 400;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "Mar 14 12:00:00 2027 GMT" → 距今天數（無效回 null）。 */
export function certDaysLeft(validTo: string | undefined, now = Date.now()): number | null {
  if (!validTo) return null;
  const t = new Date(validTo).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - now) / 86_400_000);
}

/** 一次 HTTP 探測（HEAD 優先，405/501 退 GET）；SSRF 防護開 blockPrivate。 */
async function probeStatus(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; code: number; ms: number; error?: string }> {
  const started = Date.now();
  const opts = { headers: { "User-Agent": UA }, signal: undefined as AbortSignal | undefined };
  try {
    let res = await fetchWithLimits(
      url,
      { ...opts, method: "HEAD" },
      { timeoutMs, maxBytes: 64 * 1024, blockPrivate: true },
    );
    if (res.status === 405 || res.status === 501) {
      res = await fetchWithLimits(
        url,
        { ...opts, method: "GET" },
        { timeoutMs, maxBytes: 256 * 1024, blockPrivate: true },
      );
    }
    // 丟棄 body，避免連線洐漏
    await res.arrayBuffer().catch(() => {});
    const ms = Date.now() - started;
    return { ok: isOkCode(res.status), code: res.status, ms };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: 0, ms: Date.now() - started, error: message };
  }
}

/** 讀取 SSL 憑證到期日（僅 https；失敗回 null）。 */
function tlsValidTo(url: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve(null);
      return;
    }
    if (parsed.protocol !== "https:") {
      resolve(null);
      return;
    }
    const socket = connect(
      {
        host: parsed.hostname,
        port: Number(parsed.port) || 443,
        servername: parsed.hostname,
        timeout: timeoutMs,
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.destroy();
        resolve(cert && typeof cert.valid_to === "string" ? cert.valid_to : null);
      },
    );
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(null);
    });
  });
}

function pollMinutesOf(config: Record<string, string>): number {
  const n = Number(config.pollMinutes ?? "30");
  return Number.isInteger(n) && n >= 10 && n <= 1440 ? n : 30;
}

function certWarnDaysOf(config: Record<string, string>): number {
  const n = Number(config.certWarnDays ?? "14");
  return Number.isInteger(n) && n >= 1 && n <= 180 ? n : 14;
}

function timeoutOf(config: Record<string, string>): number {
  const n = Number(config.timeoutMs ?? "10000");
  return Number.isFinite(n) && n >= 1000 && n <= 60000 ? n : 10000;
}

function readState(ctx: { taskState: (t: string) => Record<string, unknown> | undefined }): MonitorState {
  const st = ctx.taskState(TASK) as Partial<MonitorState> | undefined;
  return {
    sites: Array.isArray(st?.sites) ? (st.sites as string[]) : [],
    status: (st?.status ?? {}) as Record<string, SiteState>,
    cert: (st?.cert ?? {}) as Record<string, CertState>,
  };
}

/** 單站完整檢查（HTTP + SSL）→ 回覆文字。 */
export async function checkSite(url: string, config: Record<string, string>, now = Date.now()): Promise<string> {
  const timeoutMs = timeoutOf(config);
  const r = await probeStatus(url, timeoutMs);
  const host = hostOf(url);
  if (!r.ok) {
    const why = r.code > 0 ? `HTTP ${r.code}` : `連線失敗（${r.error ?? "unknown"}）`;
    return `🔴 ${host}：${why}`;
  }
  const validTo = await tlsValidTo(url, timeoutMs);
  const days = certDaysLeft(validTo ?? undefined, now);
  const certPart = days === null ? "" : days < 0 ? `｜SSL 已過期 ${Math.abs(days)} 天` : `｜SSL 剩 ${days} 天`;
  return `🟢 ${host}：HTTP ${r.code}（${r.ms} ms）${certPart}`;
}

const websiteSkill: SkillDefinition = {
  id: "website",
  name: "網站監控",
  description: {
    zh: "監控網站 HTTP 狀態與 SSL 憑證到期，異常或即將過期時推播（免 key）。",
    en: "Monitor site HTTP status and SSL certificate expiry; push on failure or near expiry (no key).",
    ja: "サイトの HTTP 状態と SSL 証明書の期限を監視し、異常や期限間近に通知（キー不要）。",
  },
  usage: {
    zh: "網站 https://example.com；網站 訂閱 https://example.com 30；網站 清單；網站 取消 https://example.com",
    en: "site https://example.com; site subscribe https://example.com 30; site list; site cancel https://example.com",
    ja: "サイト https://example.com; サイト 購読 https://example.com 30; サイト 一覧; サイト 解除 https://example.com",
  },
  category: { zh: "運維監控", en: "Monitoring", ja: "監視" },
  defaultTrigger: "網站",
  triggerAliases: ["監控", "網站監控", "探測", "website", "ssl"],
  fields: [
    {
      key: "pollMinutes",
      label: { zh: "檢查間隔（分鐘）", en: "Check interval (min)", ja: "チェック間隔（分）" },
      hint: "預設 30；10–1440",
    },
    {
      key: "certWarnDays",
      label: { zh: "SSL 到期提醒天數", en: "SSL expiry warning (days)", ja: "SSL 期限警告（日）" },
      hint: "預設 14；憑證剩餘天數低於此值就提醒",
    },
    {
      key: "timeoutMs",
      label: { zh: "連線逾時（ms）", en: "Timeout (ms)", ja: "タイムアウト（ms）" },
      hint: "預設 10000；1000–60000",
    },
  ],
  async health(): Promise<SkillHealth[]> {
    return [{ name: "網站監控", ok: true, detail: "就緒（HTTP + node:tls）" }];
  },
  async run(ctx: SkillContext): Promise<void> {
    const args = ctx.args.replace(/請幫忙|請幫|幫忙|的/g, " ").trim();
    const minutes = pollMinutesOf(ctx.config);
    const watchOpts = { task: TASK, everyMinutes: minutes };
    const url = /(https?:\/\/[^\s]+)/i.exec(args)?.[1]?.replace(/[，。；、]+$/, "");

    // 取消
    if (/^(取消|退訂|停止)/.test(args)) {
      const st = readState(ctx);
      if (/全部/.test(args)) {
        if (st.sites.length === 0) {
          await ctx.reply("目前沒有監控中的網站。");
          return;
        }
        ctx.unwatch(TASK);
        await ctx.reply(`已取消全部 ${st.sites.length} 個網站監控。`);
        return;
      }
      if (!url) {
        await ctx.reply("用法：網站 取消 https://example.com（或 取消全部）");
        return;
      }
      if (!st.sites.includes(url)) {
        await ctx.reply("這個網站不在監控清單裡。");
        return;
      }
      const sites = st.sites.filter((s) => s !== url);
      const status = { ...st.status };
      const cert = { ...st.cert };
      delete status[url];
      delete cert[url];
      if (sites.length === 0) {
        ctx.unwatch(TASK);
        await ctx.reply(`已取消監控：${hostOf(url)}（清單已空，停止檢查）`);
        return;
      }
      ctx.watch({ ...watchOpts, state: { sites, status, cert } });
      await ctx.reply(`已取消監控：${hostOf(url)}\n剩 ${sites.length} 個網站。`);
      return;
    }

    // 清單
    if (/^(清單|列表|list)$/.test(args)) {
      const st = readState(ctx);
      if (st.sites.length === 0) {
        await ctx.reply("目前沒有監控中的網站。用法：網站 訂閱 https://example.com");
        return;
      }
      const lines = st.sites.map((s) => {
        const prev = st.status[s];
        const state = prev ? (prev.ok ? "🟢 正常" : `🔴 異常（HTTP ${prev.code}）`) : "⏳ 尚未檢查";
        const days = st.cert[s]?.days;
        const cert = days === undefined ? "" : days < 0 ? `｜SSL 已過期` : `｜SSL 剩 ${days} 天`;
        return `・${hostOf(s)} ${state}${cert}`;
      });
      await ctx.reply(`監控中的網站（${st.sites.length}，${describeWatch(watchOpts)}檢查）：\n${lines.join("\n")}`);
      return;
    }

    if (!url) {
      await ctx.reply("用法：\n網站 https://example.com（單次探測）\n網站 訂閱 https://example.com 30");
      return;
    }

    // 訂閱
    if (/訂閱|subscribe/.test(args)) {
      const st = readState(ctx);
      if (st.sites.includes(url)) {
        await ctx.reply("已經在監控這個網站了。");
        return;
      }
      if (st.sites.length >= MAX_SITES) {
        await ctx.reply(`監控已達上限（${MAX_SITES} 個），請先取消舊的。`);
        return;
      }
      const m = /訂閱\s*(?:https?:\/\/\S+\s*)?(\d{1,4})?/.exec(args.replace(url, " "));
      const n = m?.[1] ? Number(m[1]) : minutes;
      if (!Number.isInteger(n) || n < 10 || n > 1440) {
        await ctx.reply("檢查間隔需為 10–1440 分鐘，例如：網站 訂閱 https://example.com 30");
        return;
      }
      const opts = { ...watchOpts, everyMinutes: n };
      ctx.watch({ ...opts, state: { ...st, sites: [...st.sites, url] } });
      const probe = await checkSite(url, ctx.config);
      await ctx.reply(`已加入監控：${hostOf(url)}（${describeWatch(opts)}檢查）\n${probe}`);
      return;
    }

    // 單次探測
    await ctx.reply(await checkSite(url, ctx.config));
  },
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const st = ctx.state as Partial<MonitorState>;
    const sites = Array.isArray(st.sites) ? (st.sites as string[]) : [];
    if (sites.length === 0) return;
    const status: Record<string, SiteState> = { ...((st.status ?? {}) as Record<string, SiteState>) };
    const cert: Record<string, CertState> = { ...((st.cert ?? {}) as Record<string, CertState>) };
    const timeoutMs = timeoutOf(ctx.config);
    const warnDays = certWarnDaysOf(ctx.config);
    const now = Date.now();
    let changed = false;

    for (const url of sites) {
      const r = await probeStatus(url, timeoutMs);
      const prev = status[url];
      status[url] = { ok: r.ok, code: r.code, checkedAt: now };
      changed = true;

      if (!r.ok && (prev === undefined || prev.ok)) {
        const why = r.code > 0 ? `HTTP ${r.code}` : `連線失敗`;
        await ctx.reply(`🔴 網站異常：${hostOf(url)}（${why}）`);
      } else if (r.ok && prev !== undefined && !prev.ok) {
        await ctx.reply(`🟢 網站恢復：${hostOf(url)}（HTTP ${r.code}）`);
      }

      // SSL 憑證
      const validTo = await tlsValidTo(url, timeoutMs);
      const days = certDaysLeft(validTo ?? undefined, now);
      if (days !== null) {
        const prevCert = cert[url];
        const shouldWarn = (days >= 0 && days <= warnDays) || days < 0;
        const alreadyWarned = prevCert?.warned ?? false;
        if (shouldWarn && !alreadyWarned) {
          const label = days < 0 ? `已過期 ${Math.abs(days)} 天` : `剩 ${days} 天`;
          await ctx.reply(`⚠️ SSL 憑證問題：${hostOf(url)}（${label}）`);
          cert[url] = { days, warned: true };
          changed = true;
        } else if (!shouldWarn && alreadyWarned) {
          cert[url] = { days, warned: false };
          changed = true;
        } else if (days !== prevCert?.days) {
          cert[url] = { days, warned: alreadyWarned };
          changed = true;
        }
      }
    }

    if (changed) {
      await ctx.saveState({ sites, status, cert });
    }
  },
};

export default websiteSkill;
