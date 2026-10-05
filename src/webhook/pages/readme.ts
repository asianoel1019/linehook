/* * IM Webhook頁面模板（由 server.ts 拆出，NEXT2 D1）。 */
import { readFileSync, statSync } from "node:fs";
import { marked } from "marked";
import { config } from "../../config.js";
import { tr } from "../../i18n.js";
import { page } from "../shell.js";

let readmeCache: { mtime: number; html: string } | null = null;
/**
 * README HTML 消毒（B7）：marked 不做消毒，這裡以允許清單過濾。
 * 移除 script/style/iframe/object/embed/form、事件屬性（on*）、
 * javascript:/data:(非圖片)/vbscript: URL。
 */
export function sanitizeReadmeHtml(html: string): string {
  let out = String(html);
  out = out.replace(/<(script|style|iframe|object|embed|form|input|button|textarea|select|option|meta|link|base|noscript)[\s\S]*?<\/\1\s*>/gi, "");
  out = out.replace(/<(script|style|iframe|object|embed|form|input|button|textarea|select|option|meta|link|base|noscript)(\s[^>]*)?\/?>/gi, "");
  out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(/\s+(href|src|xlink:href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (_m, attr, _q, d1, d2, d3) => {
    const value = String(d1 ?? d2 ?? d3 ?? "").trim();
    const lower = value.toLowerCase().replace(/[\s\u0000-\u001f]+/g, "");
    if (/^(javascript|vbscript|data(?=:)):/.test(lower)) {
      // data: 僅允許圖片
      if (lower.startsWith("data:") && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/.test(lower)) {
        return ` ${attr}="${value}"`;
      }
      return "";
    }
    return ` ${attr}="${value.replace(/"/g, "&quot;")}"`;
  });
  return out;
}
function readmeHtml() {
    try {
        let statMtime = -1;
        try {
            statMtime = statSync("./README.md").mtimeMs;
        } catch {
            statMtime = -1;
        }
        if (readmeCache !== null && readmeCache.mtime === statMtime) return readmeCache.html;
        const markdown = readFileSync("./README.md", "utf8");
        const html = marked.parse(markdown, { async: false });
        readmeCache = { mtime: statMtime, html: sanitizeReadmeHtml(String(html)) };
    }
    catch (error) {
        readmeCache = { mtime: -2, html: `<p>無法讀取 README.md：${String(error)}</p>` };
    }
    return readmeCache.html;
}
export function renderReadmeHtml() {
    const body = `<div class="glass md">${readmeHtml()}</div>`;
    return page(tr(config.language, "title_readme"), "readme", body, "");
}
