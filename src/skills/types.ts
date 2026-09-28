import type { SkillConfig } from "../config.js";

/** 技能自帶的多語文字（zh/en/ja）。任一語言缺漏時回退到 zh。 */
export interface LocalizedText {
  zh: string;
  en?: string;
  ja?: string;
}

/** 解析技能多語欄位為指定語言（缺漏回退 zh）。 */
export function resolveText(value: string | LocalizedText | undefined, lang: string): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (lang === "en") return value.en || value.zh;
  if (lang === "ja") return value.ja || value.zh;
  return value.zh;
}

export interface SkillContext {
  text: string;
  args: string;
  fromName: string;
  chat: string;
  fromMid: string;
  config: Record<string, string>;
  reply: (text: string) => Promise<void>;
  sendImage: (source: string, filename?: string) => Promise<void>;
  sendFile: (source: string, filename?: string) => Promise<void>;
  /** 排程一則文字訊息給目前對話；runAt 為 epoch 毫秒，回傳排程 id。 */
  schedule: (text: string, runAt: number) => string;
}

export interface SkillFieldOption {
  value: string;
  label: string;
}

export interface SkillField {
  key: string;
  label: string | LocalizedText;
  hint?: string | LocalizedText;
  secret?: boolean;
  type?: "text" | "password" | "textarea" | "file" | "select";
  options?: SkillFieldOption[];
}

export interface SkillHealth {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SkillDefinition {
  id: string;
  name: string;
  /** 技能說明；可為單一字串或自帶 zh/en/ja 的多語物件。 */
  description: string | LocalizedText;
  /** 用法範例（可含多語），供 help 顯示，例如「股價 2330」。 */
  usage?: string | LocalizedText;
  /** 分類標籤（可含多語），用於技能庫顯示，例如「交通」「金融」。 */
  category?: string | LocalizedText;
  /** 預設觸發詞（使用者可在設定覆寫），例如「火車」「時刻表」。 */
  defaultTrigger: string;
  /** 額外可接受的觸發詞別名（例如「肯德雞」「肯德」）。 */
  triggerAliases?: string[];
  /** 觸發詞固定（由程式碼決定），設定頁不顯示可編輯的觸發詞欄位。 */
  hideTrigger?: boolean;
  /**
   * 觸發模式：
   * - "assistant"（預設）：需以「<助理名稱>請幫忙 <觸發詞> …」呼叫。
   * - "any"：每則收到的訊息都會呼叫（技能自行判斷是否回應，如關鍵字自動回覆）。
   */
  triggerMode?: "assistant" | "any";
  /** 使用者需填寫的設定欄位。 */
  fields: SkillField[];
  /**
   * 可重複的規則欄位（選填）。有此欄位時，設定頁會提供新增/刪除規則列的編輯器，
   * 並將結果序列化為 JSON 陣列存入 config[ruleKey]。
   */
  ruleFields?: SkillField[];
  /** ruleFields 序列化後存入的 config key，預設 "rules"。 */
  ruleKey?: string;
  /** 選填：回報資料來源健康狀態，供 /skills 頁面顯示。 */
  health?: () => Promise<SkillHealth[]>;
  /** 執行技能；args 為觸發詞之後的原始文字（"any" 模式為整則訊息）。 */
  run: (ctx: SkillContext) => Promise<void>;
}

export function isSkillEnabled(skills: SkillConfig[], id: string): SkillConfig | undefined {
  return skills.find((skill) => skill.id === id);
}
