import type { SkillConfig } from "../config.js";
import { config } from "../config.js";
import { tr, type Lang } from "../i18n.js";
import { getSkill } from "./index.js";
import { resolveText, type SkillDefinition, type SkillField } from "./types.js";

/** 有效觸發模式（技能設定可覆寫定義）。 */
export function effectiveMode(skill: SkillConfig, def: SkillDefinition): "assistant" | "any" {
  const cfgMode = skill.config?.mode;
  return (cfgMode === "any" || cfgMode === "assistant" ? cfgMode : def.triggerMode) ?? "assistant";
}

/** 別名設定的最小形狀（SkillConfig 的子集；測試與外部呼叫可只帶這三個欄位）。 */
export interface AliasSettings {
  trigger?: string;
  disabledAliases?: string[];
  extraAliases?: string[];
}

/**
 * 有效別名＝內建別名扣掉使用者停用的＋使用者自訂追加的（去重保序）。
 * 舊設定沒有這兩個欄位時等同全部啟用、無追加（無痛升級）。
 */
export function effectiveAliases(skill: AliasSettings, def: SkillDefinition): string[] {
  const disabled = new Set(
    (skill.disabledAliases ?? []).map((a) => String(a ?? "").trim()).filter(Boolean),
  );
  const out: string[] = [];
  for (const raw of def.triggerAliases ?? []) {
    const a = String(raw ?? "").trim();
    if (!a || disabled.has(a) || out.includes(a)) continue;
    out.push(a);
  }
  for (const raw of skill.extraAliases ?? []) {
    const a = String(raw ?? "").trim();
    if (!a || out.includes(a)) continue;
    out.push(a);
  }
  return out;
}

/** 有效觸發詞清單：第一個是主觸發詞，後面是有效別名（衝突偵測的 words 直接用這個）。 */
export function effectiveTriggerWords(skill: AliasSettings, def: SkillDefinition): string[] {
  const primary = String(skill.trigger || def.defaultTrigger || "").trim();
  return [primary, ...effectiveAliases(skill, def)].filter(Boolean);
}

/** 使用者可透過觸發詞呼叫的技能（啟用、assistant 模式、非隱藏）。 */
export function triggerableSkills(): Array<{ skill: SkillConfig; def: SkillDefinition; trigger: string }> {  const out: Array<{ skill: SkillConfig; def: SkillDefinition; trigger: string }> = [];
  for (const skill of config.skills) {
    if (!skill.enabled) continue;
    const def = getSkill(skill.id);
    if (!def) continue;
    if (effectiveMode(skill, def) !== "assistant") continue;
    if (def.hideTrigger) continue;
    const trigger = (skill.trigger || def.defaultTrigger || "").trim();
    if (!trigger) continue;
    out.push({ skill, def, trigger });
  }
  return out;
}

/** 由技能定義與觸發詞產生該技能的用法說明（多語）。傳入 entry 時顯示有效別名（扣掉停用的、含自訂的）。 */
export function skillUsageText(def: SkillDefinition, trigger: string, lang: Lang, entry?: AliasSettings): string {
  const lines: string[] = [];
  lines.push(`${def.name}｜${trigger}`);
  const desc = resolveText(def.description, lang);
  if (desc) lines.push(desc);

  const aliases = entry ? effectiveAliases(entry, def) : (def.triggerAliases ?? []).filter(Boolean);
  if (aliases.length > 0) lines.push(`${tr(lang, "help_aliases")}：${[trigger, ...aliases].join("、")}`);

  const asst = config.assistant.name.trim() || "助理";
  const usage = resolveText(def.usage, lang);
  lines.push(`${tr(lang, "help_usage")}：${asst}請幫忙 ${usage || `${trigger} …`}`);

  const fields = def.fields.filter((f) => f.key !== "mode");
  if (fields.length > 0) {
    const labels = fields.map((f) => fieldLabel(f, lang)).join("、");
    lines.push(`${tr(lang, "help_settings")}：${labels}`);
  }
  return lines.join("\n");
}

function fieldLabel(f: SkillField, lang: Lang): string {
  const base = resolveText(f.label, lang) || f.key;
  return f.secret ? `${base}（${tr(lang, "help_secret")}）` : base;
}

/** 列出所有可用技能（依分類分組），供 Layer 1 使用。 */
export function skillListText(lang: Lang): string {
  const items = triggerableSkills();
  if (items.length === 0) return tr(lang, "help_no_skills");

  const groups = new Map<string, string[]>();
  for (const { def, trigger } of items) {
    const cat = resolveText(def.category, lang) || tr(lang, "help_other");
    const arr = groups.get(cat) ?? [];
    arr.push(trigger);
    groups.set(cat, arr);
  }

  const asst = config.assistant.name.trim() || "助理";
  const lines: string[] = [`${tr(lang, "help_title")}（${asst}${tr(lang, "help_call")}）：`];
  for (const [cat, triggers] of groups) {
    lines.push(`【${cat}】${triggers.join("、")}`);
  }
  lines.push(tr(lang, "help_layer2").replace("{asst}", asst));
  return lines.join("\n");
}
