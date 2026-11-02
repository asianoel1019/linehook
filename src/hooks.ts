import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * P2 跨專案通知閘道：hook 設定（事件 → 對話/平台/範本/條件）＋範本渲染。
 * 設定存在 data/hooks.json（獨立檔，不混進 settings.json；金鑰屬機密但此檔權限跟其他資料檔一致）。
 */

export interface HookConfig {
  /** hook 名稱（URL 片段；小寫、數字、-、_）。 */
  name: string;
  /** 顯示用說明。 */
  description?: string;
  /** 目標對話（名稱或平台 id）。 */
  to: string;
  /** 目標平台（line／telegram／whatsapp／teams／discord）。 */
  platform: string;
  /** 訊息範本（支援 {{a.b}} 與 {{a.b | upper}} 等濾鏡）。空＝直接送 body.text。 */
  template?: string;
  /** 只在 body 文字（含所有值）包含其中任一關鍵字時才送（降噪）。 */
  include?: string[];
  /** body 文字包含其中任一關鍵字就不送。 */
  exclude?: string[];
  /** 停用（保留設定但不投遞）。 */
  disabled?: boolean;
  /** per-hook 簽章金鑰（hex 或文字；設定了才要求簽章）。 */
  secret?: string;
  /** 最近投遞狀態（成功/失敗/時間/錯誤），給狀態查詢用。 */
  lastDelivery?: {
    at: number;
    ok: boolean;
    error?: string;
    target?: string;
  };
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_HOOKS = 100;

let overridePath: string | null = null;

/** 測試用：改存檔位置。 */
export function setHooksPath(path: string | null): void {
  overridePath = path;
}

function hooksPath(): string {
  if (overridePath) return overridePath;
  return resolve(config.schedulesPath, "..", "hooks.json");
}

function normalizeHook(raw: unknown): HookConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim().toLowerCase() : "";
  if (!NAME_RE.test(name)) return null;
  const to = typeof r.to === "string" ? r.to.trim() : "";
  const platform = typeof r.platform === "string" ? r.platform.trim().toLowerCase() : "line";
  if (!to) return null;
  const list = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : undefined;
  const last = r.lastDelivery as HookConfig["lastDelivery"];
  return {
    name,
    ...(typeof r.description === "string" ? { description: r.description } : {}),
    to,
    platform,
    ...(typeof r.template === "string" ? { template: r.template } : {}),
    ...(list(r.include) ? { include: list(r.include) } : {}),
    ...(list(r.exclude) ? { exclude: list(r.exclude) } : {}),
    ...(r.disabled === true ? { disabled: true } : {}),
    ...(typeof r.secret === "string" && r.secret ? { secret: r.secret } : {}),
    ...(last && typeof last.at === "number" ? { lastDelivery: last } : {}),
  };
}

function load(): HookConfig[] {
  try {
    if (!existsSync(hooksPath())) return [];
    const raw = JSON.parse(readFileSync(hooksPath(), "utf8")) as { hooks?: unknown };
    const list = Array.isArray(raw?.hooks) ? raw.hooks : [];
    const out: HookConfig[] = [];
    for (const h of list) {
      const hook = normalizeHook(h);
      if (hook) out.push(hook);
    }
    return out;
  } catch (error) {
    logger.warn("讀取 hook 設定失敗", { error: String(error) });
    return [];
  }
}

function save(hooks: HookConfig[]): void {
  try {
    const path = hooksPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ hooks }, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (error) {
    logger.warn("寫入 hook 設定失敗", { error: String(error) });
  }
}

/** 全部 hook（不含 secret 值以外的處理；secret 會保留給驗章用，回傳時另行遮蔽）。 */
export function listHooks(): HookConfig[] {
  return load();
}

/** 依名稱取 hook。 */
export function getHook(name: string): HookConfig | undefined {
  const key = (name || "").trim().toLowerCase();
  return load().find((h) => h.name === key);
}

/** 新增或更新 hook（同名覆蓋）。回傳錯誤字串表示失敗。 */
export function upsertHook(input: Partial<HookConfig> & { name?: string }): { ok: true; hook: HookConfig } | { ok: false; error: string } {
  const hook = normalizeHook(input);
  if (!hook) return { ok: false, error: "hook 設定不合法（需要 name／to；name 限小寫字母數字與 -_）" };
  const hooks = load();
  const idx = hooks.findIndex((h) => h.name === hook.name);
  if (idx >= 0) hooks[idx] = { ...hooks[idx], ...hook };
  else {
    if (hooks.length >= MAX_HOOKS) return { ok: false, error: `hook 數量上限 ${MAX_HOOKS}` };
    hooks.push(hook);
  }
  save(hooks);
  return { ok: true, hook: hooks[idx >= 0 ? idx : hooks.length - 1] as HookConfig };
}

/** 刪除 hook。 */
export function deleteHook(name: string): boolean {
  const key = (name || "").trim().toLowerCase();
  const hooks = load();
  const next = hooks.filter((h) => h.name !== key);
  if (next.length === hooks.length) return false;
  save(next);
  return true;
}

/** 記錄投遞結果（給狀態查詢）。 */
export function recordHookDelivery(name: string, result: { ok: boolean; error?: string; target?: string }): void {
  const key = (name || "").trim().toLowerCase();
  const hooks = load();
  const hook = hooks.find((h) => h.name === key);
  if (!hook) return;
  hook.lastDelivery = {
    at: Date.now(),
    ok: result.ok,
    ...(result.error ? { error: result.error.slice(0, 200) } : {}),
    ...(result.target ? { target: result.target } : {}),
  };
  save(hooks);
}

/* ── 範本渲染：{{a.b.c}}、{{a.b | upper}}、{{a.b | truncate:20}} ── */

function lookupPath(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function applyFilter(value: string, filter: string): string {
  const [name, arg] = filter.split(":");
  switch ((name || "").trim()) {
    case "upper":
      return value.toUpperCase();
    case "lower":
      return value.toLowerCase();
    case "truncate": {
      const n = Number(arg ?? 40);
      return Number.isFinite(n) && n > 0 ? value.slice(0, n) : value;
    }
    default:
      return value;
  }
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * 渲染範本：{{path}} 取值、{{path | filter}} 套濾鏡、{{path | default:文字}} 給預設值。
 * 取不到的路徑留空字串（不顯示 undefined）。
 */
export function renderTemplate(template: string, data: unknown): string {
  if (!template) return "";
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr: string) => {
    const parts = expr.split("|").map((p) => p.trim());
    const path = parts[0] ?? "";
    const filter = parts[1] ?? "";
    const value = lookupPath(data, path);
    if (value === undefined || value === null) {
      if (filter.startsWith("default:")) return filter.slice("default:".length);
      return "";
    }
    let text = stringify(value);
    if (filter) text = applyFilter(text, filter);
    return text;
  });
}

/**
 * 降噪判斷：include（任一命中才送）與 exclude（任一命中就不送）。
 * 比對的是 payload 全部文字（key 與 value 都算），簡單可預期。
 */
export function matchesHookFilters(hook: HookConfig, payload: unknown): { pass: boolean; reason?: string } {
  const text = flattenText(payload).toLowerCase();
  if (hook.exclude && hook.exclude.length > 0) {
    for (const word of hook.exclude) {
      const w = word.trim().toLowerCase();
      if (w && text.includes(w)) return { pass: false, reason: `命中排除詞「${word}」` };
    }
  }
  if (hook.include && hook.include.length > 0) {
    for (const word of hook.include) {
      const w = word.trim().toLowerCase();
      if (w && text.includes(w)) return { pass: true };
    }
    return { pass: false, reason: "未命中任何包含詞" };
  }
  return { pass: true };
}

/** 把 payload 攤平成可搜尋的文字（key 與值都算）。 */
export function flattenText(payload: unknown): string {
  const parts: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (value === null || value === undefined) return;
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        parts.push(k);
        walk(v, depth + 1);
      }
      return;
    }
    parts.push(String(value));
  };
  walk(payload, 0);
  return parts.join(" ");
}
