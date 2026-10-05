import { resolveText, type SkillDefinition } from "./types.js";

/**
 * 驗證技能設定值（F2）：在 POST /skills 存檔與啟動載入時呼叫，
 * 把「設定錯誤」提前到設定時擋下，並指出是哪個技能的哪個欄位。
 * 回傳錯誤訊息陣列；空陣列 = 通過。
 */
export function validateSkillConfig(
  def: SkillDefinition,
  config: Record<string, string>,
  lang = "zh",
): string[] {
  const errors: string[] = [];
  const labelOf = (key: string): string => {
    const field = def.fields.find((f) => f.key === key);
    return field ? resolveText(field.label, lang) || key : key;
  };
  for (const field of def.fields) {
    const raw = (config[field.key] ?? "").trim();
    if (field.required && !raw) {
      errors.push(`「${def.name}」缺少必填欄位「${labelOf(field.key)}」`);
      continue;
    }
    if (!raw) continue;
    if (field.pattern) {
      let re: RegExp;
      try {
        re = new RegExp(field.pattern);
      } catch {
        errors.push(`「${def.name}」欄位「${labelOf(field.key)}」的 pattern 非法正則`);
        continue;
      }
      if (!re.test(raw)) {
        errors.push(`「${def.name}」欄位「${labelOf(field.key)}」格式不符`);
      }
    }
    if (field.min !== undefined || field.max !== undefined) {
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        errors.push(`「${def.name}」欄位「${labelOf(field.key)}」需為數字`);
      } else {
        if (field.min !== undefined && num < field.min) {
          errors.push(`「${def.name}」欄位「${labelOf(field.key)}」不可小於 ${field.min}`);
        }
        if (field.max !== undefined && num > field.max) {
          errors.push(`「${def.name}」欄位「${labelOf(field.key)}」不可大於 ${field.max}`);
        }
      }
    }
    if (field.type === "select" && field.options && field.options.length > 0) {
      const values = field.options.map((o) => o.value);
      if (!values.includes(raw)) {
        errors.push(`「${def.name}」欄位「${labelOf(field.key)}」的值不在選項內`);
      }
    }
  }
  return errors;
}
