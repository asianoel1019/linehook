import { logger } from "../../logger.js";
import { fetchChart, resolveSymbol } from "../stock/index.js";
import { getRates, toCode } from "../exchange-rate/index.js";
import { parseTtl } from "../cache.js";
import type { SkillContext, SkillDefinition, SkillHealth, SkillTaskContext } from "../types.js";
import { describeWatch } from "../watch.js";

const TASK = "check";
const MAX_ALERTS = 20;

export interface Alert {
  id: string;
  kind: "stock" | "fx";
  label: string;
  symbol?: string;
  base?: string;
  target?: string;
  dir: "above" | "below";
  price: number;
}

export interface AlertState {
  alerts: Alert[];
}

export type AlertCommand =
  | { op: "list" }
  | { op: "cancel"; key: string }
  | { op: "add-stock"; symbol: string; dir: "above" | "below" | "infer"; price: number }
  | { op: "add-fx"; base: string; target: string; dir: "above" | "below" | "infer"; price: number }
  | { op: "help" };

const DIR_ABOVE_RE = /高於|上穿|突破|>=|＞|>|站上/;
const DIR_BELOW_RE = /低於|下穿|跌破|<=|＜|</;
const FX_HINT_RE = /匯率|外幣|外匯|換匯|\bFX\b/i;

function findNumbers(text: string): Array<{ value: number; index: number }> {
  const out: Array<{ value: number; index: number }> = [];
  const re = /(\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ value: Number(m[1]), index: m.index });
  return out;
}

/** 從文字中依出現順序找出幣別代碼（支援中文名與代碼）。 */
function findCurrencyCodes(text: string): string[] {
  const codes: Array<{ code: string; index: number }> = [];
  const keys = ["美金", "美元", "台幣", "新台幣", "日幣", "日圓", "日元", "人民幣", "歐元", "韓元", "港幣", "英鎊", "新加坡幣", "泰銖", "澳幣", "加幣"];
  const probe = (name: string) => {
    const code = toCode(name);
    if (!code) return;
    let idx = text.indexOf(name);
    while (idx >= 0) {
      if (!codes.some((c) => c.code === code)) codes.push({ code, index: idx });
      idx = text.indexOf(name, idx + name.length);
    }
  };
  for (const k of keys) probe(k);
  const upper = text.toUpperCase();
  const codeRe = /\b([A-Z]{3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(upper))) {
    if (/^[A-Z]{3}$/.test(m[1]) && toCode(m[1])) {
      if (!codes.some((c) => c.code === m![1])) codes.push({ code: m[1], index: m.index });
    }
  }
  return codes.sort((a, b) => a.index - b.index).map((c) => c.code);
}

/** 解析到價通知指令（純函式，可測試）。 */
export function parseAlertCommand(args: string): AlertCommand {
  const cleaned = args
    .replace(/請幫忙|請幫|幫忙|查詢|查一下|警示|到價|通知|的/g, " ")
    .trim();
  if (/^(清單|列表|list)$/i.test(cleaned)) return { op: "list" };
  const cancel = /^(取消|刪除|移除|del|cancel)\s*(.+)?$/i.exec(cleaned);
  if (cancel) {
    const key = (cancel[2] ?? "").trim();
    if (!key) return { op: "help" };
    return { op: "cancel", key };
  }

  const above = DIR_ABOVE_RE.exec(cleaned);
  const below = DIR_BELOW_RE.exec(cleaned);
  const dirMatch = above && (!below || above.index <= below.index) ? above : below;
  const dir: "above" | "below" | "infer" = !dirMatch
    ? "infer"
    : dirMatch === above
      ? "above"
      : "below";

  const numbers = findNumbers(cleaned);
  const price = dirMatch
    ? numbers.find((n) => n.index > (dirMatch?.index ?? -1))?.value
    : numbers[numbers.length - 1]?.value;

  const codes = findCurrencyCodes(cleaned);
  if (FX_HINT_RE.test(cleaned) || codes.length >= 2) {
    if (codes.length < 2 || price === undefined) return { op: "help" };
    const [base, target] = codes;
    if (base === target) return { op: "help" };
    return { op: "add-fx", base, target, dir, price };
  }

  const symbol = resolveSymbol(cleaned);
  if (!symbol || price === undefined) return { op: "help" };
  return { op: "add-stock", symbol, dir, price };
}

/** 是否觸發（純函式，可測試）。 */
export function isHit(dir: "above" | "below", current: number, target: number): boolean {
  return dir === "above" ? current >= target : current <= target;
}

async function getStockPrice(symbol: string): Promise<{ price: number; name: string }> {
  const { meta, closes } = await fetchChart(symbol, "1d");
  const price = meta.regularMarketPrice ?? closes[closes.length - 1];
  if (price === undefined || !Number.isFinite(price)) throw new Error("查無股價");
  return { price, name: meta.longName || meta.shortName || symbol };
}

async function getFxRate(base: string, target: string, ttlMs: number): Promise<number> {
  const data = await getRates(base, ttlMs);
  const rate = data.rates[target];
  if (!Number.isFinite(rate)) throw new Error(`查不到 ${base} → ${target} 的匯率`);
  return rate;
}

function fmtPrice(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 4 : 2 });
}

function alertLine(a: Alert, i: number): string {
  const dirText = a.dir === "above" ? "高於" : "低於";
  return `${i + 1}. ${a.label} ${dirText} ${fmtPrice(a.price)}`;
}

function readAlerts(ctx: { taskState: (t: string) => Record<string, unknown> | undefined }): Alert[] {
  const state = ctx.taskState(TASK) as Partial<AlertState> | undefined;
  return Array.isArray(state?.alerts) ? (state.alerts as Alert[]) : [];
}

function checkMinutesOf(config: Record<string, string>): number {
  const n = Number(config.checkMinutes ?? "30");
  return Number.isInteger(n) && n >= 5 && n <= 1440 ? n : 30;
}

const priceAlertSkill: SkillDefinition = {
  id: "price-alert",
  name: "到價通知",
  description: {
    zh: "股價/匯率到價時自動通知（每 N 分鐘檢查）。",
    en: "Notify when a stock price or FX rate hits your target (checked periodically).",
    ja: "株価・為替が目標に到達したら通知します（定期チェック）。",
  },
  usage: {
    zh: "警示 股價 2330 高於 2500",
    en: "alert stock 2330 above 2500",
    ja: "警示 2330 高於 2500",
  },
  category: {
    zh: "金融理財",
    en: "Finance",
    ja: "金融",
  },
  defaultTrigger: "警示",
  triggerAliases: ["到價通知", "alert"],
  fields: [
    {
      key: "checkMinutes",
      label: { zh: "檢查間隔（分鐘）", en: "Check interval (min)", ja: "チェック間隔（分）" },
      hint: "預設 30；5–1440",
    },
  ],
  async health(): Promise<SkillHealth[]> {
    return [{ name: "到價通知", ok: true, detail: "就緒" }];
  },
  async run(ctx: SkillContext): Promise<void> {
    const cmd = parseAlertCommand(ctx.args);
    const minutes = checkMinutesOf(ctx.config);
    const watchOpts = { task: TASK, everyMinutes: minutes };

    if (cmd.op === "list") {
      const alerts = readAlerts(ctx);
      if (alerts.length === 0) {
        await ctx.reply("目前沒有設定到價通知。用法：阿寶請幫忙 警示 股價 2330 高於 2500");
        return;
      }
      await ctx.reply(`到價通知共 ${alerts.length} 則（${describeWatch(watchOpts)}檢查）：\n${alerts.map(alertLine).join("\n")}`);
      return;
    }

    if (cmd.op === "cancel") {
      const alerts = readAlerts(ctx);
      const idx = /^\d+$/.test(cmd.key)
        ? Number(cmd.key) - 1
        : alerts.findIndex((a) => a.label.includes(cmd.key) || (a.symbol ?? "").toUpperCase().includes(cmd.key.toUpperCase()));
      if (idx < 0 || idx >= alerts.length) {
        await ctx.reply(`找不到「${cmd.key}」，請用「警示 清單」查看編號。`);
        return;
      }
      const removed = alerts[idx];
      alerts.splice(idx, 1);
      if (alerts.length === 0) {
        ctx.unwatch(TASK);
        await ctx.reply(`已取消：${removed.label}（已無通知，停止檢查）`);
        return;
      }
      // watch 會取代同名任務，直接帶上更新後的 alerts
      ctx.watch({ ...watchOpts, state: { alerts } });
      await ctx.reply(`已取消：${removed.label}\n剩下 ${alerts.length} 則：\n${alerts.map(alertLine).join("\n")}`);
      return;
    }

    if (cmd.op === "help") {
      await ctx.reply(
        "用法：\n警示 股價 2330 高於 2500\n警示 2330 低於 2000（方向可省略，會依現價推斷）\n警示 匯率 美金 台幣 低於 29.5\n警示 清單／警示 取消 1",
      );
      return;
    }

    const alerts = readAlerts(ctx);
    if (alerts.length >= MAX_ALERTS) {
      await ctx.reply(`到價通知已達上限（${MAX_ALERTS} 則），請先取消舊的。`);
      return;
    }

    try {
      if (cmd.op === "add-stock") {
        const { price: current, name } = await getStockPrice(cmd.symbol);
        const dir = cmd.dir === "infer" ? (cmd.price >= current ? "above" : "below") : cmd.dir;
        const label = `${name} ${cmd.symbol}`;
        if (isHit(dir, current, cmd.price)) {
          await ctx.reply(`${label} 現價 ${fmtPrice(current)} 已${dir === "above" ? "高於" : "低於"} ${fmtPrice(cmd.price)}，不需設定通知。`);
          return;
        }
        alerts.push({
          id: Date.now().toString(36).slice(-6),
          kind: "stock",
          label,
          symbol: cmd.symbol,
          dir,
          price: cmd.price,
        });
        ctx.watch({ ...watchOpts, state: { alerts } });
        await ctx.reply(
          `已設定：${label} ${dir === "above" ? "高於" : "低於"} ${fmtPrice(cmd.price)} 時通知（現價 ${fmtPrice(current)}，${describeWatch(watchOpts)}檢查）`,
        );
        return;
      }
      // add-fx
      const ttlMs = parseTtl(ctx.config.cacheTtl, 60);
      const rate = await getFxRate(cmd.base, cmd.target, ttlMs);
      const dir = cmd.dir === "infer" ? (cmd.price >= rate ? "above" : "below") : cmd.dir;
      const label = `${cmd.base}→${cmd.target}`;
      if (isHit(dir, rate, cmd.price)) {
        await ctx.reply(`${label} 現價 ${fmtPrice(rate)} 已${dir === "above" ? "高於" : "低於"} ${fmtPrice(cmd.price)}，不需設定通知。`);
        return;
      }
      alerts.push({
        id: Date.now().toString(36).slice(-6),
        kind: "fx",
        label,
        base: cmd.base,
        target: cmd.target,
        dir,
        price: cmd.price,
      });
      ctx.watch({ ...watchOpts, state: { alerts } });
      await ctx.reply(
        `已設定：${label} ${dir === "above" ? "高於" : "低於"} ${fmtPrice(cmd.price)} 時通知（現價 ${fmtPrice(rate)}，${describeWatch(watchOpts)}檢查）`,
      );
    } catch (error) {
      logger.warn("到價通知設定失敗", { error: error instanceof Error ? error.message : String(error) });
      await ctx.reply(`設定失敗：${error instanceof Error ? error.message : String(error)}`);
    }
  },
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const state = ctx.state as Partial<AlertState>;
    const alerts: Alert[] = Array.isArray(state.alerts) ? state.alerts : [];
    if (alerts.length === 0) return;
    const ttlMs = parseTtl(ctx.config.cacheTtl, 60);
    const fired: string[] = [];
    const rest: Alert[] = [];
    for (const a of alerts) {
      try {
        const current = a.kind === "stock"
          ? (await getStockPrice(a.symbol ?? "")).price
          : await getFxRate(a.base ?? "", a.target ?? "", ttlMs);
        if (isHit(a.dir, current, a.price)) {
          fired.push(`${a.label} 現價 ${fmtPrice(current)} 已${a.dir === "above" ? "高於" : "低於"} ${fmtPrice(a.price)}`);
        } else {
          rest.push(a);
        }
      } catch (error) {
        logger.warn("到價檢查失敗，保留通知", {
          label: a.label,
          error: error instanceof Error ? error.message : String(error),
        });
        rest.push(a);
      }
    }
    if (rest.length !== alerts.length) {
      await ctx.saveState({ alerts: rest });
    }
    if (fired.length > 0) {
      await ctx.reply(`🔔 到價通知：\n${fired.join("\n")}`);
    }
  },
};

export default priceAlertSkill;
