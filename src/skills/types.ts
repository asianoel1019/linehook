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
  /**
   * 註冊週期性技能任務（例如到價檢查、RSS 輪詢、晨報）。
   * 同一對話中同 skillId+task 再次註冊會取代舊任務。回傳任務 id。
   */
  watch: (opts: WatchOptions) => string;
  /** 取消任務：可傳任務 id 或任務名稱（同 skillId+對話範圍內）；回傳是否成功取消。 */
  unwatch: (taskOrId: string) => boolean;
  /** 列出目前對話中此技能的任務。 */
  watches: () => SkillWatchView[];
  /** 讀取目前對話中某任務的 state 副本（找不到回 undefined）。 */
  taskState: (taskOrId: string) => Record<string, unknown> | undefined;
}

/** 註冊 watch 任務的選項；cron / everyMinutes / at 三選一（都沒給預設每 30 分鐘）。 */
export interface WatchOptions {
  /** 技能自訂的任務名稱（例如 "check"、"poll"、"daily"），同一對話同名會取代。 */
  task: string;
  /** 標準 5 欄 cron（例如 "0 8 * * *"）。 */
  cron?: string;
  /** 每 N 分鐘執行一次（1–1440；超過 60 需為 60 的倍數）。 */
  everyMinutes?: number;
  /** 每日固定時間 "HH:mm"（例如 "08:00"）。 */
  at?: string;
  /** 傳給 onTask 的參數（僅允許 string/number/boolean，會持久化）。 */
  args?: Record<string, string | number | boolean>;
  /** 任務初始狀態（會持久化，onTask 可用 saveState 更新）。 */
  state?: Record<string, unknown>;
}

export interface SkillWatchView {
  id: string;
  task: string;
  cron: string;
  runAt: string;
  args: Record<string, string | number | boolean>;
}

/** 週期任務觸發時傳給技能 onTask 的上下文。 */
export interface SkillTaskContext {
  /** 任務 id（scheduler job id）。 */
  taskId: string;
  /** 註冊時的任務名稱。 */
  task: string;
  chat: string;
  fromName: string;
  config: Record<string, string>;
  args: Record<string, string | number | boolean>;
  /** 上次 saveState 存下的狀態。 */
  state: Record<string, unknown>;
  /** 合併更新狀態並持久化。 */
  saveState: (patch: Record<string, unknown>) => Promise<void>;
  reply: (text: string) => Promise<void>;
  sendImage: (source: string, filename?: string) => Promise<void>;
  sendFile: (source: string, filename?: string) => Promise<void>;
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
  /** 必填（F2）：為空時存檔擋下並指出欄位。 */
  required?: boolean;
  /** 值的正則（字串形式）；不符時擋下。 */
  pattern?: string;
  /** 數字欄位的最小/最大值。 */
  min?: number;
  max?: number;
  /** 預設值（UI 初始填入；後端不自動填，只做驗證）。 */
  default?: string;
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
  /**
   * 週期任務回呼（選填）。技能用 ctx.watch() 註冊任務後，
   * 每次到時框架會呼叫此函式；回傳內容由技能自行決定是否 reply。
   */
  onTask?: (ctx: SkillTaskContext) => Promise<void>;
}

export function isSkillEnabled(skills: SkillConfig[], id: string): SkillConfig | undefined {
  return skills.find((skill) => skill.id === id);
}
