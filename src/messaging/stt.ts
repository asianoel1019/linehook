import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { fetchJson } from "../net.js";

/**
 * P3 語音輸入：把收到的音訊轉成文字，再照常走技能管線（回覆仍是文字）。
 * 供應商三選一（環境變數或沿用全域 LLM 設定）：
 *   - openai：POST {base}/audio/transcriptions（whisper 相容）
 *   - gemini：generateContent + inline_data（音訊直接內嵌）
 *   - local：本機 whisper CLI（STT_LOCAL_BIN）
 * provider=none（預設）＝不轉錄（語音訊息會提示使用者改用文字）。
 */

export type SttProvider = "none" | "openai" | "gemini" | "local";

export interface IncomingAudio {
  /** base64（不含 data: 前綴）。 */
  base64: string;
  mimeType: string;
  durationMs?: number;
}

export interface SttConfig {
  provider: SttProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** 語言提示（zh／en…）；空＝讓模型自己判斷。 */
  language: string;
  /** 本機 whisper CLI 路徑。 */
  localBin: string;
}

/** 目前 STT 設定（env 優先，缺則沿用全域 LLM 的 key／base／model）。 */
export function sttConfig(): SttConfig {
  const provider = (config.sttProvider || "none").toLowerCase() as SttProvider;
  const global = (config as { globalLlm?: { apiKey?: string; baseUrl?: string; model?: string } }).globalLlm ?? {};
  return {
    provider,
    apiKey: config.sttApiKey?.trim() || global.apiKey?.trim() || "",
    baseUrl:
      config.sttBaseUrl?.trim() ||
      (provider === "gemini" ? "https://generativelanguage.googleapis.com" : global.baseUrl?.trim() || "https://api.openai.com/v1"),
    model:
      config.sttModel?.trim() ||
      (provider === "gemini" ? "gemini-2.0-flash" : provider === "openai" ? "whisper-1" : global.model?.trim() || ""),
    timeoutMs: config.sttTimeoutMs,
    language: config.sttLanguage?.trim() || "",
    localBin: config.sttLocalBin?.trim() || "",
  };
}

function extOf(mimeType: string): string {
  const m = (mimeType || "").toLowerCase();
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  if (m.includes("flac")) return "flac";
  return "bin";
}

/** OpenAI 相容的 /audio/transcriptions。 */
async function transcribeOpenAi(audio: IncomingAudio, cfg: SttConfig): Promise<string> {
  if (!cfg.apiKey) throw new Error("STT 未設定 API key");
  const form = new FormData();
  const bytes = Buffer.from(audio.base64, "base64");
  form.append("file", new Blob([new Uint8Array(bytes)], { type: audio.mimeType }), `voice.${extOf(audio.mimeType)}`);
  form.append("model", cfg.model || "whisper-1");
  if (cfg.language) form.append("language", cfg.language);
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`STT HTTP ${res.status}${body ? `：${body.slice(0, 150)}` : ""}`);
  }
  const data = (await res.json()) as { text?: unknown };
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (!text) throw new Error("STT 未回傳文字");
  return text;
}

/** Gemini：音訊以 inline_data 內嵌。 */
async function transcribeGemini(audio: IncomingAudio, cfg: SttConfig): Promise<string> {
  if (!cfg.apiKey) throw new Error("STT 未設定 API key");
  const base = cfg.baseUrl.replace(/\/$/, "");
  const model = cfg.model || "gemini-2.0-flash";
  const data = await fetchJson<{
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  }>(
    `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inline_data: { mime_type: audio.mimeType, data: audio.base64 } },
              { text: cfg.language ? `請把這段語音轉成文字（${cfg.language}）。只輸出轉錄文字。` : "請把這段語音轉成文字。只輸出轉錄文字。" },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    },
  );
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("STT 未回傳文字");
  return text;
}

/** 本機 whisper CLI（whisper.cpp：whisper-cli -f <file> -otxt -of <out>）。 */
async function transcribeLocal(audio: IncomingAudio, cfg: SttConfig): Promise<string> {
  if (!cfg.localBin) throw new Error("STT 未設定本機 whisper 路徑（STT_LOCAL_BIN）");
  const dir = mkdtempSync(join(tmpdir(), "imhook-stt-"));
  const ext = extOf(audio.mimeType);
  const file = join(dir, `voice.${ext}`);
  const outBase = join(dir, "out");
  try {
    writeFileSync(file, Buffer.from(audio.base64, "base64"));
    const args = ["-f", file, "-otxt", "-of", outBase];
    if (cfg.language) args.push("-l", cfg.language);
    const stdout = await new Promise<string>((resolve, reject) => {
      const proc = spawn(cfg.localBin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      proc.stderr.on("data", (d: Buffer) => {
        err += d.toString("utf8");
      });
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
        reject(new Error(`本機 STT 逾時（${cfg.timeoutMs}ms）`));
      }, cfg.timeoutMs);
      timer.unref?.();
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`本機 STT 啟動失敗：${e.message}`));
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`本機 STT 失敗（exit ${code}）：${err.slice(0, 150)}`));
      });
    });
    let text = stdout.trim();
    if (!text) {
      try {
        text = readFileSync(`${outBase}.txt`, "utf8").trim();
      } catch {
        text = "";
      }
    }
    if (!text) throw new Error("本機 STT 未輸出文字");
    return text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 轉錄一則音訊；失敗丟錯（呼叫端決定怎麼回使用者）。 */
export async function transcribeAudio(audio: IncomingAudio, cfg: SttConfig = sttConfig()): Promise<string> {
  if (!audio?.base64) throw new Error("沒有音訊內容");
  if (cfg.provider === "none") throw new Error("語音轉文字未啟用（設定 STT_PROVIDER 與對應憑證）");
  const started = Date.now();
  const text =
    cfg.provider === "openai"
      ? await transcribeOpenAi(audio, cfg)
      : cfg.provider === "gemini"
        ? await transcribeGemini(audio, cfg)
        : await transcribeLocal(audio, cfg);
  logger.info("語音已轉文字", { provider: cfg.provider, ms: Date.now() - started, chars: text.length });
  return text;
}
