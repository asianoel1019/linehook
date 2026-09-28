import { logger } from "../../logger.js";
import { nowInTz } from "../../time.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchText as netFetchText } from "../../net.js";
import type { SkillContext, SkillDefinition } from "../types.js";

const CACHE_NAME = "lottery-invoice";
const USER_AGENT = "Mozilla/5.0 (compatible; LineHook/1.0)";

interface InvoiceResult {
  termLabel: string;
  special: string[];
  grand: string[];
  head: string[];
}

interface LottoResult {
  name: string;
  period: string;
  date: string;
  numbers: number[];
  extra?: number[];
  extraLabel?: string;
}

async function fetchText(url: string): Promise<string> {
  return netFetchText(
    url,
    { headers: { "User-Agent": USER_AGENT } },
    { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
  );
}

// ===== 統一發票 =====
function rocYear(): number {
  return nowInTz().getFullYear() - 1911;
}

/** 最近一期「已開獎」期別（單月）。
 *  統一發票期別為 1,3,5,7,9,11 月（涵蓋 2 個月），開獎日為「期別+2」月的 25 日。
 *  例：07~08 月（期別 07）於 9/25 開獎；故 9/27 時最新為 11507。 */
function currentTerm(): string {
  const now = nowInTz();
  const year = now.getFullYear() - 1911;
  const candidates: Array<[number, number, number]> = [];
  for (const yy of [year, year - 1]) {
    for (const pp of [1, 3, 5, 7, 9, 11]) {
      const drawMonthRaw = pp + 2; // 3,5,7,9,11,13
      const drawYear = drawMonthRaw > 12 ? yy + 1 : yy;
      const drawMonth = drawMonthRaw > 12 ? drawMonthRaw - 12 : drawMonthRaw;
      const draw = new Date(drawYear + 1911, drawMonth - 1, 25);
      if (draw.getTime() <= now.getTime()) candidates.push([yy, pp, draw.getTime()]);
    }
  }
  candidates.sort((a, b) => b[2] - a[2]);
  const [y, p] = candidates[0];
  return `${y}${String(p).padStart(2, "0")}`;
}

function prevTerm(term: string): string {
  const year = Number(term.slice(0, term.length - 2));
  const month = Number(term.slice(-2));
  if (month === 1) return `${year - 1}11`;
  return `${year}${String(month - 2).padStart(2, "0")}`;
}

function termLabel(term: string): string {
  const year = term.slice(0, term.length - 2);
  const month = Number(term.slice(-2));
  return `${year}年 ${String(month).padStart(2, "0")}~${String(month + 1).padStart(2, "0")} 月`;
}

function cellNumbers(body: string, label: string): string[] {
  const i = body.indexOf(`>${label}</th>`);
  if (i < 0) return [];
  const after = body.slice(i);
  const tdEnd = after.indexOf("</td>");
  const seg = tdEnd > 0 ? after.slice(0, tdEnd) : after.slice(0, 600);
  return [...seg.matchAll(/class="col-12 mb-3">\s*([0-9A-Z]{3,8})\s*</g)].map((m) => m[1]);
}

async function getInvoice(term: string): Promise<InvoiceResult> {
  const url = `https://www.etax.nat.gov.tw/etw-main/ETW183W2_${term}`;
  const html = await fetchText(url);
  const special = cellNumbers(html, "特別獎");
  const grand = cellNumbers(html, "特獎");
  const head = cellNumbers(html, "頭獎");
  if (special.length === 0 && grand.length === 0 && head.length === 0) {
    throw new Error("無法解析發票號碼");
  }
  return { termLabel: termLabel(term), special, grand, head };
}

/** 取得指定期別（或更早）的發票中獎號碼；找不到則往前一期。 */
async function getInvoiceWithFallback(term: string, isPrev: boolean): Promise<{ result: InvoiceResult; term: string }> {
  if (isPrev) {
    return { result: await getInvoice(term), term };
  }
  // 最新一期：若尚未開獎（404/無資料），自動退回前一期
  let current = term;
  for (let i = 0; i < 3; i++) {
    try {
      return { result: await getInvoice(current), term: current };
    } catch {
      current = prevTerm(current);
    }
  }
  throw new Error("查無發票資料");
}

function formatInvoice(inv: InvoiceResult): string {
  const lines = [
    `統一發票中獎號碼（${inv.termLabel}）：`,
    `特別獎：${inv.special.join("、") || "-"}`,
    `特獎：${inv.grand.join("、") || "-"}`,
    `頭獎：${inv.head.join("、") || "-"}`,
  ];
  return lines.join("\n");
}

// ===== 樂透 =====
async function fetchLotto(kind: "lotto649" | "super638", monthsBack: number): Promise<LottoResult | null> {
  const now = nowInTz();
  for (let i = 0; i <= monthsBack + 2; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const endpoint = kind === "lotto649" ? "Lotto649Result" : "SuperLotto638Result";
    const key = kind === "lotto649" ? "lotto649Res" : "superLotto638Res";
    try {
      const res = await fetch(
        `https://api.taiwanlottery.com/TLCAPIWeB/Lottery/${endpoint}?period=&month=${month}`,
        { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { content?: Record<string, unknown> };
      const arr = (data.content?.[key] as Array<Record<string, unknown>> | undefined) ?? [];
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const latest = arr[0]; // 由新到舊
      const drawSize = (latest.drawNumberSize as number[]) ?? [];
      const numbers = drawSize.slice(0, kind === "lotto649" ? 6 : 6);
      const extra = kind === "lotto649" ? [drawSize[6]] : [drawSize[6]];
      const date = String(latest.lotteryDate ?? "").slice(0, 10);
      const period = String(latest.period ?? "");
      return {
        name: kind === "lotto649" ? "大樂透" : "威力彩",
        period,
        date,
        numbers,
        extra,
        extraLabel: kind === "lotto649" ? "特別號" : "第二區",
      };
    } catch {
      // try next month
    }
  }
  return null;
}

function formatLotto(r: LottoResult): string {
  const nums = r.numbers.map((n) => String(n).padStart(2, "0")).join(" ");
  const extra = r.extra && Number.isFinite(r.extra[0]) ? `\n${r.extraLabel}：${String(r.extra[0]).padStart(2, "0")}` : "";
  return `${r.name}（第 ${r.period} 期 ${r.date}）開獎號碼：\n${nums}${extra}`;
}

const lotteryInvoiceSkill: SkillDefinition = {
  id: "lottery-invoice",
  name: "統一發票 / 樂透",
  description: {
    zh: "查詢統一發票中獎號碼、大樂透、威力彩開獎號碼（預設最新一期）。",
    en: "Invoice winning numbers, Lotto649, Super Lotto (latest period by default).",
    ja: "統一発票・宝くじ・スーパーロトの当せん番号（既定は最新回）。",
  },
  usage: {
    zh: "發票 上一期",
    en: "invoice",
    ja: "発票 前回",
  },
  category: {
    zh: "生活資訊",
    en: "Life",
    ja: "生活",
  },
  defaultTrigger: "發票",
  triggerAliases: ["樂透", "大樂透", "威力彩", "統一發票", "對獎"],
  hideTrigger: true,
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 60 分鐘；可填 30（分鐘）、2h、1d" },
  ],
  async run(ctx: SkillContext): Promise<void> {
    const ttlMs = parseTtl(ctx.config.cacheTtl, 60);
    const args = ctx.args;
    const isPrev = /上一期|上期|前一期/.test(args) || /上一期|上期|前一期/.test(ctx.text);

    try {
      const full = `${ctx.text} ${args}`;
      if (/威力彩|super|638/i.test(full)) {
        const key = `lotto-super638-${isPrev ? "prev" : "latest"}`;
        let r = readCache<LottoResult>(key, ttlMs);
        if (!r) {
          const latest = await fetchLotto("super638", isPrev ? 1 : 0);
          if (!latest) throw new Error("查無威力彩資料");
          r = latest;
          writeCache(key, r);
        }
        await ctx.reply(formatLotto(r));
        return;
      }
      if (/樂透|大樂透|lotto|649/i.test(full)) {
        const key = `lotto-lotto649-${isPrev ? "prev" : "latest"}`;
        let r = readCache<LottoResult>(key, ttlMs);
        if (!r) {
          const latest = await fetchLotto("lotto649", isPrev ? 1 : 0);
          if (!latest) throw new Error("查無大樂透資料");
          r = latest;
          writeCache(key, r);
        }
        await ctx.reply(formatLotto(r));
        return;
      }
      // 預設：統一發票
      const wantTerm = isPrev ? prevTerm(currentTerm()) : currentTerm();
      const cachedKey = `invoice-${wantTerm}-${isPrev ? "prev" : "latest"}`;
      let inv = readCache<InvoiceResult>(cachedKey, ttlMs);
      if (!inv) {
        const got = await getInvoiceWithFallback(wantTerm, isPrev);
        inv = got.result;
        writeCache(cachedKey, inv);
      }
      await ctx.reply(formatInvoice(inv));
      logger.info("發票查詢", { wantTerm });
    } catch (error) {
      logger.error("發票/樂透查詢失敗", { error: String(error) });
      await ctx.reply("目前查不到資料，請稍後再試。");
    }
  },
};

export default lotteryInvoiceSkill;
