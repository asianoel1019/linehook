import type { SkillContext, SkillDefinition, SkillTaskContext } from "@lw/skills/types";

/**
 * 教學範例技能（docs/skill-author-guide.md）：示範最小結構、watch 與 onTask。
 * 同時是測試輔助套件的示範對象。
 */

const WATER_TASK = "water";

const helloSkill: SkillDefinition = {
  id: "hello",
  name: "哈囉",
  description: { zh: "打招呼的示範技能", en: "A demo skill that says hello" },
  usage: { zh: "hello 世界；每天 08:00 喝水" },
  category: { zh: "工具", en: "Tools" },
  defaultTrigger: "哈囉",
  triggerAliases: ["hi"],
  fields: [
    { key: "greeting", label: { zh: "問候語", en: "Greeting" }, default: "哈囉" },
  ],
  async run(ctx: SkillContext): Promise<void> {
    const greeting = (ctx.config.greeting || "哈囉").trim();
    const args = ctx.args.trim();
    // 「每天 08:00 喝水」→ 註冊週期任務
    const daily = /^(?:每天|每日)\s*(\d{1,2}:\d{2})\s*(.*)$/.exec(args);
    if (daily) {
      const at = daily[1] as string;
      const content = (daily[2] || "喝水").trim();
      ctx.watch({ task: WATER_TASK, at, args: { text: content } });
      await ctx.reply(`已設定每天 ${at} 提醒你「${content}」。`);
      return;
    }
    await ctx.reply(`${greeting}${args ? ` ${args}` : ""}！`);
  },
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const text = typeof ctx.args.text === "string" ? ctx.args.text : "喝水";
    const st = ctx.state as { lastDay?: string };
    const today = new Date().toISOString().slice(0, 10);
    if (st.lastDay === today) return;
    await ctx.reply(`提醒：${text}`);
    await ctx.saveState({ lastDay: today });
  },
};

export default helloSkill;
