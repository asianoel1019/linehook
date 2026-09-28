import { logger } from "../../logger.js";
import type { SkillContext, SkillDefinition } from "../types.js";

export interface Unit {
  name: string;
  cat: string;
  base: number;
}

const UNITS: Record<string, Unit> = {
  // 長度（基準：公尺）
  mm: { name: "毫米", cat: "length", base: 0.001 },
  毫米: { name: "毫米", cat: "length", base: 0.001 },
  cm: { name: "公分", cat: "length", base: 0.01 },
  公分: { name: "公分", cat: "length", base: 0.01 },
  厘米: { name: "公分", cat: "length", base: 0.01 },
  m: { name: "公尺", cat: "length", base: 1 },
  公尺: { name: "公尺", cat: "length", base: 1 },
  米: { name: "公尺", cat: "length", base: 1 },
  km: { name: "公里", cat: "length", base: 1000 },
  公里: { name: "公里", cat: "length", base: 1000 },
  千米: { name: "公里", cat: "length", base: 1000 },
  吋: { name: "英吋", cat: "length", base: 0.0254 },
  inch: { name: "英吋", cat: "length", base: 0.0254 },
  英吋: { name: "英吋", cat: "length", base: 0.0254 },
  呎: { name: "英尺", cat: "length", base: 0.3048 },
  英尺: { name: "英尺", cat: "length", base: 0.3048 },
  ft: { name: "英尺", cat: "length", base: 0.3048 },
  feet: { name: "英尺", cat: "length", base: 0.3048 },
  碼: { name: "碼", cat: "length", base: 0.9144 },
  yd: { name: "碼", cat: "length", base: 0.9144 },
  英里: { name: "英里", cat: "length", base: 1609.344 },
  mi: { name: "英里", cat: "length", base: 1609.344 },
  mile: { name: "英里", cat: "length", base: 1609.344 },
  // 重量（基準：公克）
  mg: { name: "毫克", cat: "weight", base: 0.001 },
  毫克: { name: "毫克", cat: "weight", base: 0.001 },
  g: { name: "公克", cat: "weight", base: 1 },
  公克: { name: "公克", cat: "weight", base: 1 },
  克: { name: "公克", cat: "weight", base: 1 },
  kg: { name: "公斤", cat: "weight", base: 1000 },
  公斤: { name: "公斤", cat: "weight", base: 1000 },
  千克: { name: "公斤", cat: "weight", base: 1000 },
  台斤: { name: "台斤", cat: "weight", base: 600 },
  斤: { name: "台斤", cat: "weight", base: 600 },
  兩: { name: "兩", cat: "weight", base: 37.5 },
  lb: { name: "磅", cat: "weight", base: 453.59237 },
  磅: { name: "磅", cat: "weight", base: 453.59237 },
  oz: { name: "盎司", cat: "weight", base: 28.349523125 },
  盎司: { name: "盎司", cat: "weight", base: 28.349523125 },
  噸: { name: "公噸", cat: "weight", base: 1_000_000 },
  t: { name: "公噸", cat: "weight", base: 1_000_000 },
  // 面積（基準：平方公尺）
  "m2": { name: "平方公尺", cat: "area", base: 1 },
  平方公尺: { name: "平方公尺", cat: "area", base: 1 },
  "cm2": { name: "平方公分", cat: "area", base: 0.0001 },
  平方公分: { name: "平方公分", cat: "area", base: 0.0001 },
  "km2": { name: "平方公里", cat: "area", base: 1_000_000 },
  平方公里: { name: "平方公里", cat: "area", base: 1_000_000 },
  公頃: { name: "公頃", cat: "area", base: 10000 },
  ha: { name: "公頃", cat: "area", base: 10000 },
  坪: { name: "坪", cat: "area", base: 3.305785 },
  甲: { name: "甲", cat: "area", base: 2934 },
  acre: { name: "英畝", cat: "area", base: 4046.8564224 },
  英畝: { name: "英畝", cat: "area", base: 4046.8564224 },
  // 體積（基準：公升）
  ml: { name: "毫升", cat: "volume", base: 0.001 },
  毫升: { name: "毫升", cat: "volume", base: 0.001 },
  cc: { name: "毫升", cat: "volume", base: 0.001 },
  l: { name: "公升", cat: "volume", base: 1 },
  公升: { name: "公升", cat: "volume", base: 1 },
  升: { name: "公升", cat: "volume", base: 1 },
  加侖: { name: "加侖", cat: "volume", base: 3.785411784 },
  gal: { name: "加侖", cat: "volume", base: 3.785411784 },
  gallon: { name: "加侖", cat: "volume", base: 3.785411784 },
  // 速度（基準：km/h）
  "km/h": { name: "公里/小時", cat: "speed", base: 1 },
  kmh: { name: "公里/小時", cat: "speed", base: 1 },
  時速: { name: "公里/小時", cat: "speed", base: 1 },
  mph: { name: "英里/小時", cat: "speed", base: 1.609344 },
  "mi/h": { name: "英里/小時", cat: "speed", base: 1.609344 },
  "m/s": { name: "公尺/秒", cat: "speed", base: 3.6 },
  節: { name: "節", cat: "speed", base: 1.852 },
  knot: { name: "節", cat: "speed", base: 1.852 },
  // 溫度（特殊處理）
  "°c": { name: "°C", cat: "temp", base: 1 },
  c: { name: "°C", cat: "temp", base: 1 },
  度c: { name: "°C", cat: "temp", base: 1 },
  攝氏: { name: "°C", cat: "temp", base: 1 },
  celsius: { name: "°C", cat: "temp", base: 1 },
  "°f": { name: "°F", cat: "temp", base: 1 },
  f: { name: "°F", cat: "temp", base: 1 },
  度f: { name: "°F", cat: "temp", base: 1 },
  華氏: { name: "°F", cat: "temp", base: 1 },
  fahrenheit: { name: "°F", cat: "temp", base: 1 },
  k: { name: "K", cat: "temp", base: 1 },
  kelvin: { name: "K", cat: "temp", base: 1 },
  克氏: { name: "K", cat: "temp", base: 1 },
  絕對溫度: { name: "K", cat: "temp", base: 1 },
};

const ALIASES = Object.keys(UNITS).sort((a, b) => b.length - a.length);

function toCelsius(v: number, unit: string): number {
  const key = unit.toLowerCase();
  if (["°f", "f", "度f", "華氏", "fahrenheit"].includes(key)) return (v - 32) / 1.8;
  if (["k", "kelvin", "克氏", "絕對溫度"].includes(key)) return v - 273.15;
  return v;
}

function fromCelsius(v: number, unit: string): number {
  const key = unit.toLowerCase();
  if (["°f", "f", "度f", "華氏", "fahrenheit"].includes(key)) return v * 1.8 + 32;
  if (["k", "kelvin", "克氏", "絕對溫度"].includes(key)) return v + 273.15;
  return v;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return Number(n.toFixed(digits)).toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** 純換算核心：回傳換算結果與正規化後的單位（溫度走攝氏中轉）。 */
export function convertUnits(
  value: number,
  fromAlias: string,
  toAlias: string,
): { value: number; from: Unit; to: Unit } {
  const from = UNITS[fromAlias.toLowerCase()];
  const to = UNITS[toAlias.toLowerCase()];
  if (!from || !to) throw new Error(`未知單位：${!from ? fromAlias : toAlias}`);
  if (from.cat !== to.cat) throw new Error(`「${from.name}」與「${to.name}」屬於不同類別，無法換算。`);
  const valueOut =
    from.cat === "temp"
      ? fromCelsius(toCelsius(value, fromAlias), toAlias)
      : (value * from.base) / to.base;
  return { value: valueOut, from, to };
}

const unitSkill: SkillDefinition = {
  id: "unit",
  name: "單位換算",
  description: {
    zh: "換算單位（長度/重量/面積/體積/速度/溫度）。",
    en: "Unit conversion (length/weight/area/volume/speed/temperature).",
    ja: "単位換算（長さ/重さ/面積/体積/速度/温度）。",
  },
  usage: {
    zh: "換算 100 公分 公尺",
    en: "convert 100 cm m",
    ja: "換算 100 cm m",
  },
  category: {
    zh: "工具",
    en: "Tools",
    ja: "ツール",
  },
  defaultTrigger: "換算",
  triggerAliases: ["單位換算", "單位", "convert", "轉換"],
  fields: [],
  async run(ctx: SkillContext): Promise<void> {
    const text = ctx.args
      .replace(/請幫忙|請幫|幫忙|幫我|查詢|查一下|換算|轉換|單位|等於|是多少|多少|幾/g, " ")
      .replace(/[，,、]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const numMatch = text.match(/-?\d+(?:\.\d+)?/);
    if (!numMatch) {
      await ctx.reply("請提供數值與單位，例如：阿寶請幫忙 換算 100 公分 公尺");
      return;
    }
    const value = Number(numMatch[0]);

    let rest = text.slice(0, numMatch.index ?? 0) + " " + text.slice((numMatch.index ?? 0) + numMatch[0].length);
    rest = rest.replace(/\bto\b|\bin\b|到|換成|轉成|成|→|->|=/gi, " ").toLowerCase();

    const found: Array<{ alias: string; unit: Unit }> = [];
    let i = 0;
    while (i < rest.length && found.length < 2) {
      let matched = false;
      for (const alias of ALIASES) {
        if (rest.startsWith(alias, i)) {
          const unit = UNITS[alias];
          const last = found[found.length - 1];
          if (!last || last.unit.name !== unit.name || last.unit.cat !== unit.cat) found.push({ alias, unit });
          i += alias.length;
          matched = true;
          break;
        }
      }
      if (!matched) i += 1;
    }

    if (found.length < 2) {
      await ctx.reply("請提供「來源單位」與「目標單位」，例如：阿寶請幫忙 換算 100 公分 公尺");
      return;
    }
    const [from, to] = found;
    if (from.unit.cat !== to.unit.cat) {
      await ctx.reply(`「${from.unit.name}」與「${to.unit.name}」屬於不同類別，無法換算。`);
      return;
    }

    let out: number;
    try {
      const converted = convertUnits(value, from.alias, to.alias);
      out = converted.value;
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : String(error));
      return;
    }
    logger.info("單位換算", { from: from.unit.name, to: to.unit.name, value });
    await ctx.reply(`${fmt(value)} ${from.unit.name} = ${fmt(out)} ${to.unit.name}`);
  },
};

export default unitSkill;
