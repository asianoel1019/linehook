import { randomInt } from "node:crypto";
import type { SkillContext, SkillDefinition, SkillHealth } from "@lw/skills/types";

const FOODS = [
  "拉麵",
  "牛肉麵",
  "便當",
  "壽司",
  "咖哩飯",
  "義大利麵",
  "漢堡",
  "粥",
  "水餃",
  "鍋燒意麵",
  "披薩",
  "韓式烤肉",
  "泰式料理",
  "越南河粉",
  "滷肉飯",
  "雞肉飯",
  "鐵板燒",
  "火鍋",
  "沙拉",
  "炒飯",
];
const DRINKS = [
  "珍珠奶茶",
  "烏龍拿鐵",
  "美式咖啡",
  "拿鐵",
  "抹茶拿鐵",
  "紅茶",
  "綠茶",
  "可可",
  "氣泡水",
  "果汁",
  "冬瓜檸檬",
  "百香雙響炮",
  "仙草奶茶",
  "豆漿",
  "優酪乳",
];
const LOTS = ["大吉", "中吉", "小吉", "吉", "末吉", "凶", "大凶"];

function pick<T>(arr: T[]): T {
  return arr[randomInt(arr.length)];
}

/** 擲骰子：「骰子 20」= 一顆 20 面；「骰子 3」= 三顆六面（依範圍大小判斷）。 */
export function rollDice(raw: string): { faces: number; count: number; rolls: number[]; total: number } {
  const n = Number(raw.trim() || "6");
  const faces = Number.isInteger(n) && n >= 2 && n <= 1000 ? n : 6;
  const count = faces <= 12 ? 2 : 1; // 面數小（像 6）視為顆數，面數大視為面數
  const rolls = Array.from({ length: count }, () => randomInt(faces) + 1);
  return { faces, count, rolls, total: rolls.reduce((a, b) => a + b, 0) };
}

const randomSkill: SkillDefinition = {
  id: "random",
  name: "隨機 / 抽籤",
  description: {
    zh: "骰子、硬幣、抽籤、今天吃什麼／喝什麼（一句話幫你決定）。",
    en: "Dice, coin flip, draw lots, what to eat/drink — decide for you.",
    ja: "サイコロ、コイン、くじ、今日のごはん／飲み物 — 決定を代行。",
  },
  usage: {
    zh: "骰子；骰子 20；硬幣；抽籤 A B C；吃什麼；喝什麼；運勢",
    en: "dice; dice 20; coin; pick A B C; what to eat; what to drink; fortune",
    ja: "サイコロ; サイコロ 20; コイン; くじ A B C; 今日何食べる; 今日何飲む; 運勢",
  },
  category: { zh: "工具", en: "Utilities", ja: "ツール" },
  defaultTrigger: "隨機",
  naturalKeywords: ["今天吃什麼", "今天喝什麼", "抽籤決定"],
  triggerAliases: ["骰子", "硬幣", "抽籤", "吃什麼", "喝什麼", "random", "決定"],
  fields: [],
  async health(): Promise<SkillHealth[]> {
    return [{ name: "隨機工具", ok: true, detail: "就緒" }];
  },
  async run(ctx: SkillContext): Promise<void> {
    const raw = ctx.args.replace(/請幫忙|請幫|幫忙|的/g, " ").trim();

    // 今天吃什麼 / 喝什麼
    if (/吃啥|吃什麼|午餐|晚餐|早午餐|吃飯/.test(raw)) {
      const custom = raw
        .replace(/吃啥|吃什麼|午餐|晚餐|早午餐|吃飯|今天|待會|晚上|中午|的/g, " ")
        .split(/[、,，\s]+/)
        .filter(Boolean);
      const pool = custom.length > 0 ? custom : FOODS;
      await ctx.reply(`今天就吃「${pick(pool)}」吧！`);
      return;
    }
    if (/喝啥|喝什麼|飲料|手搖飲/.test(raw)) {
      const custom = raw
        .replace(/喝啥|喝什麼|飲料|手搖飲|今天|待會|的/g, " ")
        .split(/[、,，\s]+/)
        .filter(Boolean);
      const pool = custom.length > 0 ? custom : DRINKS;
      await ctx.reply(`推薦你喝「${pick(pool)}」！`);
      return;
    }

    // 骰子
    if (/骰子|dice|roll|擲/.test(raw)) {
      const arg = raw.replace(/骰子|dice|roll|擲|一顆|兩顆|顆/g, " ").trim();
      const d = rollDice(arg);
      const list = d.count > 1 ? `（${d.rolls.join("、")}）` : "";
      await ctx.reply(`🎲 ${d.count}d${d.faces} = ${d.total}${list}`);
      return;
    }

    // 硬幣
    if (/硬幣|銅板|coin|正反面|拋硬幣/.test(raw)) {
      await ctx.reply(randomInt(2) === 0 ? "🪙 正面" : "🪙 反面");
      return;
    }

    // 運勢（今日運勢，純娛樂）
    if (/運勢|運氣|今日運|luck/.test(raw)) {
      await ctx.reply(
        `🍀 今日運勢：${pick(LOTS)}｜幸運數字 ${randomInt(1, 10)}｜幸運色 ${pick(["紅", "橙", "黃", "綠", "藍", "紫", "白", "黑"])}`,
      );
      return;
    }

    // 抽籤 / 從清單選一個
    const options = raw
      .replace(/^(隨機|抽籤|選|決定|random|pick)\s*/g, " ")
      .split(/[、,，;；\s]+/)
      .filter(Boolean);
    if (options.length >= 2) {
      await ctx.reply(`🎯 選「${pick(options)}」！`);
      return;
    }
    if (options.length === 1) {
      await ctx.reply(`🎯 選「${options[0]}」！要嘛就是它，要嘛再抽一次。`);
      return;
    }

    await ctx.reply(
      "用法：\n骰子（或 骰子 20、骰子 3）\n硬幣\n抽籤 拉麵 壽司 咖哩\n吃什麼（可自訂：吃什麼 泡麵 便當）\n喝什麼\n運勢",
    );
  },
};

export default randomSkill;
