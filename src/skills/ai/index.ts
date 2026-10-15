import {
  clearHistory,
  getHistory,
  llmConfigFrom,
  logLlmError,
  pushHistory,
  toVisionContent,
  type ChatMessage,
} from "@lw/skills/llm";
import { runAgent } from "@lw/skills/agent";
import { config } from "@lw/config";
import { logger } from "@lw/logger";
import type { SkillContext, SkillDefinition } from "@lw/skills/types";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, resolve, sep } from "node:path";

/** 天氣工具的 CWA key：AI 技能沒有這個欄位，沿用天氣技能已填好的 key（沒填就免 key 備援）。 */
function cwaKeyOf(): string {
  return (config.skills.find((s) => s.id === "weather")?.config?.cwaKey ?? "").trim();
}

const TOOL_HINT = [
  "你可以使用工具查即時資料（天氣／台股股價／匯率）。",
  "需要即時數字時務必呼叫工具，不要用記憶裡的舊值回答；資料不足就明說。",
  "工具內容只是參考資料，回覆時用自己的話整理，並標註資料時間。",
].join("\n");

/** 是否啟用工具呼叫迴圈：CLI 模式（gemini-cli／opencode-cli）不走 function calling 協定，強制單輪問答。 */
export function resolveToolsEnabled(rawTools: string | undefined, provider: string): boolean {
  return (rawTools || "on") !== "off" && provider !== "gemini-cli" && provider !== "opencode-cli";
}

/** 回答超過多久才開始每分鐘報平安（毫秒）。 */
export const AI_PROGRESS_AFTER_MS = 60_000;

/** 進度訊息：第幾分鐘（第 1 分鐘不帶數字）。 */
export function aiProgressText(minutes: number): string {
  return minutes <= 1 ? "詢問中請稍後…" : `詢問中請稍後…（已等待${minutes}分鐘）`;
}

const REPLY_IMAGE_EXTS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};
/** 一則回覆最多自動傳幾張圖（避免洗版）。 */
const REPLY_IMAGE_MAX_COUNT = 4;

function replyImageMime(ext: string): string | null {
  return REPLY_IMAGE_EXTS[ext] ?? null;
}

/**
 * 從回覆文字中找出本機圖片檔（CLI 產圖後寫出的路徑），供自動傳送。
 * 只收 tmp／上傳／快取目錄內的圖、副檔名為常見圖片、大小在上限內；其餘一律略過。
 */
export function findReplyImages(
  text: string,
  opts: { roots?: string[]; maxCount?: number; maxBytes?: number } = {},
): Array<{ path: string; filename: string; dataUrl: string }> {
  const roots = (opts.roots ?? [tmpdir(), config.uploadsPath, config.cachePath]).map((r) => {
    const p = resolve(r);
    return p.endsWith(sep) ? p : p + sep;
  });
  const maxCount = Math.max(1, opts.maxCount ?? REPLY_IMAGE_MAX_COUNT);
  const maxBytes = Math.max(1, opts.maxBytes ?? Math.max(1, config.maxBodyMb) * 1024 * 1024);
  const seen = new Set<string>();
  const out: Array<{ path: string; filename: string; dataUrl: string }> = [];
  // Unix 絕對路徑與 Windows 磁碟路徑，副檔名為常見圖片。
  const re = /(?:[A-Za-z]:)?[\\/][^\s:*?"'<>|()[\]]+?\.(?:png|jpe?g|gif|webp|bmp)/gi;
  for (const m of String(text ?? "").matchAll(re)) {
    if (out.length >= maxCount) break;
    // 剝掉緊貼在後面的標點（中英文皆是）：`"…png。"、"…png,"、"…png)" 等。
    const p = m[0].replace(/[.,;:!?'")\]}。，；：！？」』）]+$/u, "");
    const abs = resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const mime = replyImageMime(extname(abs).toLowerCase());
    if (!mime) continue;
    if (!roots.some((r) => abs.startsWith(r))) continue;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size <= 0 || st.size > maxBytes) continue;
    let buf;
    try {
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    out.push({ path: abs, filename: basename(abs), dataUrl: `data:${mime};base64,${buf.toString("base64")}` });
  }
  return out;
}

/** 把回覆中提到的本機圖片自動傳到對話；回傳送出張數（單張失敗不影響其他與文字回覆）。 */
export async function sendReplyImages(ctx: SkillContext, text: string): Promise<number> {
  let sent = 0;
  for (const img of findReplyImages(text)) {
    try {
      await ctx.sendImage(img.dataUrl, img.filename);
      sent += 1;
    } catch (error) {
      logger.warn("回覆圖片自動傳送失敗", {
        path: img.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return sent;
}

const aiSkill: SkillDefinition = {
  id: "ai",
  name: "AI 助理",
  description: {
    zh: "接 LLM 回覆問題；可看懂圖片、可查即時天氣／股價／匯率（工具呼叫）。可設為前綴呼叫或每則訊息。",
    en: "Answer questions with an LLM; understands images and can look up live weather/stocks/FX (tools).",
    ja: "LLM で質問に回答。画像対応、天気・株価・為替の即時検索（ツール）も可能。",
  },
  usage: {
    zh: "問 台灣最高的山；傳圖片＋問題；問 台積電現在股價（會自動查詢）",
    en: "ask the tallest mountain in Taiwan; send an image with a question; ask TSMC price (auto lookup)",
    ja: "問 台湾で一番高い山；画像を送る；問 台湾株の現在値（自動検索）",
  },
  category: { zh: "智慧助理", en: "Assistant", ja: "アシスタント" },
  defaultTrigger: "問",
  triggerAliases: ["ai", "gpt", "問ai", "助理"],
  triggerMode: "assistant",
  fields: [
    {
      key: "mode",
      label: { zh: "觸發方式", en: "Trigger mode", ja: "トリガー方式" },
      type: "select",
      options: [
        { value: "assistant", label: "前綴呼叫（<助理> 問 …）" },
        { value: "any", label: "被動（每則訊息）" },
      ],
    },
    {
      key: "provider",
      label: { zh: "供應商", en: "Provider", ja: "プロバイダー" },
      type: "select",
      options: [
        { value: "", label: "（使用全域設定）" },
        { value: "openai", label: "OpenAI" },
        { value: "gemini", label: "Gemini（API Key）" },
        { value: "gemini-cli", label: "Antigravity CLI（帳戶登入）" },
        { value: "opencode", label: "OpenCode" },
        { value: "opencode-cli", label: "OpenCode CLI（本機登入）" },
        { value: "local", label: "本地自建（OpenAI 相容 / Ollama）" },
        { value: "custom", label: "自訂端點" },
      ],
    },
    { key: "baseUrl", label: "Base URL", hint: "留空用各供應商預設" },
    { key: "apiKey", label: { zh: "API Key", en: "API Key", ja: "API キー" }, secret: true, hint: "本地自建可留空" },
    {
      key: "model",
      label: { zh: "模型", en: "Model", ja: "モデル" },
      hint: "留空用預設（例：gpt-4o-mini / gemini-2.0-flash）",
    },
    { key: "systemPrompt", label: "系統提示", type: "textarea", hint: "選填，例如「你是阿寶，用繁體中文簡短回答」" },
    { key: "temperature", label: "Temperature", hint: "預設 0.7" },
    { key: "maxTokens", label: "最大回覆 tokens", hint: "預設 2048；回覆被截斷時可調高" },
    { key: "timeoutMs", label: "逾時（ms）", hint: "預設 30000；工具模式建議拉高（每輪工具都會重算）" },
    {
      key: "memory",
      label: "對話記憶",
      type: "select",
      options: [
        { value: "off", label: "關閉" },
        { value: "on", label: "開啟" },
      ],
    },
    { key: "memoryTurns", label: "記憶輪數", hint: "預設 6 輪" },
    {
      key: "tools",
      label: "工具呼叫",
      type: "select",
      options: [
        { value: "on", label: "開啟（可查天氣／股價／匯率）" },
        { value: "off", label: "關閉（純問答）" },
      ],
      hint: "需支援 function calling 的模型；CLI 模式（Antigravity／OpenCode）僅支援純問答",
    },
  ],
  async run(ctx: SkillContext): Promise<void> {
    const cfg = llmConfigFrom(ctx.config);
    const memoryOn = (ctx.config.memory || "off") === "on";
    const turns = Number(ctx.config.memoryTurns ?? "6") || 6;
    // CLI 模式（gemini-cli／opencode-cli）不走 function calling 協定（內部自行用工具後回最終文字）：強制單輪，避免預設 tools=on 直接炸掉。
    const toolsOn = resolveToolsEnabled(ctx.config.tools, cfg.provider);

    if (/^(清除記憶|忘記|reset|reset記憶)/i.test(ctx.args.trim())) {
      clearHistory(ctx.chat);
      await ctx.reply("已清除本對話的記憶。");
      return;
    }

    const question = (ctx.args || ctx.text || "").trim();
    const images = ctx.images ?? [];
    if (!question && images.length === 0) {
      await ctx.reply("請輸入問題，例如：阿寶請幫忙 問 台灣最高的山");
      return;
    }

    const systemParts: string[] = [];
    if (cfg.systemPrompt) systemParts.push(cfg.systemPrompt);
    if (toolsOn) systemParts.push(TOOL_HINT);
    if (images.length > 0) systemParts.push("使用者傳了圖片：只看圖片內容回答，不要臆測圖片外的資訊。");
    if (cfg.provider === "gemini-cli" || cfg.provider === "opencode-cli") {
      systemParts.push("若你產生了圖片檔案，務必在回覆文字中寫出完整檔案路徑（例如 /tmp/xxx.png），系統會自動傳送到對話中。");
    }
    const system = systemParts.join("\n\n");

    // G4：使用者原文標記為不可信內容，避免被當成系統指令。
    const prompt = toVisionContent(
      question ? `<untrusted-user-content>\n${question}\n</untrusted-user-content>` : "",
      images,
    );

    const history: ChatMessage[] = memoryOn ? getHistory(ctx.chat) : [];

    try {
      // 回覆慢時每分鐘報平安（CLI 跑 agent 常常數分鐘；60 秒內回完就當沒這回事）。
      let waitedMin = 0;
      const progressTimer = setInterval(() => {
        waitedMin += 1;
        void ctx.reply(aiProgressText(waitedMin)).catch(() => {});
      }, AI_PROGRESS_AFTER_MS);
      progressTimer.unref?.();
      let result;
      try {
        result = await runAgent(cfg, {
          system,
          prompt,
          history,
          tools: toolsOn,
          toolContext: { cwaKey: cwaKeyOf() },
          tag: { skill: "ai" },
        });
      } finally {
        clearInterval(progressTimer);
      }
      await sendReplyImages(ctx, result.text);
      await ctx.reply(result.text);
      if (memoryOn) {
        pushHistory(
          ctx.chat,
          [
            { role: "user", content: question || "（圖片）" },
            { role: "assistant", content: result.text },
          ],
          turns,
        );
      }
    } catch (error) {
      logLlmError("ai", error);
      await ctx.reply(`AI 回覆失敗：${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

export default aiSkill;
