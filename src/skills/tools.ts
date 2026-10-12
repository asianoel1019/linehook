/**
 * 工具註冊表：AI 技能的工具呼叫（agent）模式用。
 * 每個工具都包一層「台灣日常資料」的查詢——全部走既有的免 key／兄弟技能資料源，
 * 不接受自由格式參數（只接受宣告過的 JSON Schema）。
 */

import { fetchWeather } from "./weather/index.js";
import { fetchChart } from "./stock/index.js";
import { getRates } from "./exchange-rate/index.js";
import type { ToolSpec } from "./llm.js";
import { logger } from "../logger.js";

/** 工具宣告（JSON Schema）。 */
export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_weather",
    description: "查詢台灣指定城市的現在天氣（溫度、體感、天氣現象）。城市例如：台北、臺中、高雄。",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "台灣城市名稱（可帶「市」）" } },
      required: ["city"],
    },
  },
  {
    name: "get_stock",
    description: "查詢台股個股或大盤的即時股價與漲跌幅。symbol 例如 2330、0050、^TWII（大盤）。",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string", description: "股票代號或指數代號" } },
      required: ["symbol"],
    },
  },
  {
    name: "get_exchange_rate",
    description: "查詢匯率（即時）。from 例如 USD；to 例如 JPY，省略回 TWD。",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "來源幣別，例如 USD" },
        to: { type: "string", description: "目標幣別，例如 JPY；省略回 TWD" },
      },
      required: ["from"],
    },
  },
];

export interface ToolContext {
  /** 天氣技能的 CWA key（選填）。 */
  cwaKey?: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 執行工具；回傳純文字（錯誤也回文字，讓模型據此回覆使用者）。 */
export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  try {
    switch (name) {
      case "get_weather": {
        const city = str(args.city);
        if (!city) return "缺少 city 參數";
        const reading = await fetchWeather(city, ctx.cwaKey ?? "", 30 * 60 * 1000);
        const feels = reading.feelsC !== undefined ? `，體感 ${reading.feelsC}°C` : "";
        return `${reading.city}：${reading.tempC}°C${feels}，${reading.desc}（來源 ${reading.source}）`;
      }
      case "get_stock": {
        const symbol = str(args.symbol);
        if (!symbol) return "缺少 symbol 參數";
        const { meta } = await fetchChart(symbol, "1d");
        const price = meta?.regularMarketPrice;
        if (price === undefined || !Number.isFinite(price)) return `查無「${symbol}」的報價`;
        const prev = meta?.chartPreviousClose ?? meta?.previousClose;
        const change = prev ? price - prev : undefined;
        const pct = change !== undefined && prev ? (change / prev) * 100 : 0;
        const arrow = (change ?? 0) > 0 ? "▲" : (change ?? 0) < 0 ? "▼" : "＝";
        const name = meta?.shortName || meta?.longName || symbol;
        return `${name}（${symbol}）：${price.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${arrow}${Math.abs(change ?? 0).toFixed(2)}（${arrow}${pct.toFixed(2)}%）`;
      }
      case "get_exchange_rate": {
        const from = str(args.from).toUpperCase();
        const to = str(args.to).toUpperCase() || "TWD";
        if (!from) return "缺少 from 參數";
        const data = await getRates(from, 30 * 60 * 1000);
        const rate = data.rates[to];
        if (!Number.isFinite(rate)) return `查無 ${from}→${to} 的匯率`;
        const when = data.time_last_update_utc ? `（更新 ${data.time_last_update_utc.slice(0, 16)} UTC）` : "";
        return `1 ${from} ≈ ${rate.toFixed(4)} ${to}${when}`;
      }
      default:
        return `未知工具：${name}`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("工具執行失敗", { name, error: message });
    return `工具執行失敗：${message}`;
  }
}
