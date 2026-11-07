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

/** 別名設定的最小形狀（SkillConfig 的子集；測試與外部呼叫可只帶需要的欄位）。 */
export interface AliasSettings {
  trigger?: string;
  triggerEnabled?: boolean;
  disabledAliases?: string[];
  aliasText?: Record<string, string>;
  extraAliases?: Array<string | { text: string; enabled: boolean }>;
}

/** 一個有效觸發詞：文字＋它是主觸發詞還是別名（仲裁與衝突標示用）。 */
export interface EffectiveTrigger {
  text: string;
  primary: boolean;
}

/**
 * 有效觸發詞清單（主觸發詞永遠第一，後面是別名；去重保序）。
 * 規則：主觸發詞可單獨關閉；內建別名可改字（aliasText）或停用（disabledAliases）；
 * 自訂別名可單獨開關；字串格式的自訂別名視為啟用中（舊設定相容）。
 * 舊設定沒有這些欄位時等同全部啟用、無改字（無痛升級）。
 */
export function effectiveTriggers(skill: AliasSettings, def: SkillDefinition): EffectiveTrigger[] {
  const out: EffectiveTrigger[] = [];
  const seen = new Set<string>();
  const push = (text: unknown, primary: boolean): void => {
    const t = String(text ?? "").trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push({ text: t, primary });
  };
  if (skill.triggerEnabled !== false) {
    push(skill.trigger || def.defaultTrigger || "", true);
  }
  const disabled = new Set(
    (skill.disabledAliases ?? []).map((a) => String(a ?? "").trim()).filter(Boolean),
  );
  const overrides = skill.aliasText ?? {};
  for (const raw of def.triggerAliases ?? []) {
    const orig = String(raw ?? "").trim();
    if (!orig || disabled.has(orig)) continue;
    const edited = String(overrides[orig] ?? "").trim();
    push(edited || orig, false);
  }
  for (const item of skill.extraAliases ?? []) {
    if (typeof item === "string") push(item, false);
    else if (item && typeof item === "object" && item.enabled !== false) push(item.text, false);
  }
  return out;
}

/** 有效別名（不含主觸發詞；用法說明與舊呼叫相容用）。 */
export function effectiveAliases(skill: AliasSettings, def: SkillDefinition): string[] {
  return effectiveTriggers(skill, def)
    .filter((t) => !t.primary)
    .map((t) => t.text);
}

/** 有效觸發詞清單：第一個是主觸發詞（若有關閉則無），後面是有效別名（衝突偵測的 words 直接用這個）。 */
export function effectiveTriggerWords(skill: AliasSettings, def: SkillDefinition): string[] {
  return effectiveTriggers(skill, def).map((t) => t.text);
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
