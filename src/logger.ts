import { appendFile, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { rotateIfNeeded, rotateDailyIfNeeded } from "./rotate.js";
import { nowIso } from "./time.js";
import type { LogEntry, LogLevel } from "./types.js";

const buffer: LogEntry[] = [];

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function levelEnabled(level: LogLevel): boolean {
  const configured = (config.logLevel || "info").toLowerCase();
  const threshold = LEVEL_ORDER[configured as LogLevel] ?? LEVEL_ORDER.info;
  return LEVEL_ORDER[level] >= threshold;
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!levelEnabled(level)) return;
  const entry: LogEntry = {
    time: nowIso(),
    level,
    message,
    ...(meta ? { meta } : {}),
  };

  buffer.push(entry);
  if (buffer.length > config.logLimit) {
    buffer.splice(0, buffer.length - config.logLimit);
  }

  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  const line = `[${entry.time}] ${level.toUpperCase()} ${message}${suffix}`;
  if (level === "error") console.error(line);
  else console.log(line);

  // C7：寫入失敗要回報（至少 stderr），不要空 callback 吞掉。
  appendFile(config.logFile, `${line}\n`, (error) => {
    if (error) console.error(`[logger] 寫入 log 檔失敗: ${String(error)}`);
  });
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
  getRecent: (): LogEntry[] => [...buffer],
};

const LINE_RE = /^\[(.+?)\] (DEBUG|INFO|WARN|ERROR) (.*)$/;

/** 解析一行落檔 log（write() 的 `[time] LEVEL msg {meta}` 格式）；壞行回 null。 */
function parseLogLine(line: string): LogEntry | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  let message = m[3];
  let meta: Record<string, unknown> | undefined;
  // write() 把 meta 接在訊息後（" {...}"）；只有尾段是合法物件才拆，避免誤傷內文本來就有 JSON 的訊息。
  const brace = message.lastIndexOf(" {");
  if (brace >= 0) {
    try {
      const parsed: unknown = JSON.parse(message.slice(brace + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
        message = message.slice(0, brace);
      }
    } catch {
      // 留著當純文字
    }
  }
  return { time: m[1], level: m[2].toLowerCase() as LogLevel, message, ...(meta ? { meta } : {}) };
}

/** 從單一落檔讀今日條目（由舊到新，最多 want 筆；邊讀邊丟頭，大檔不爆內存）。 */
function readTailEntries(path: string, today: string, want: number): LogEntry[] {
  let text: string;
  try {
    if (!existsSync(path)) return [];
    if (statSync(path).size > 8 * 1024 * 1024) return [];
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: LogEntry[] = [];
  for (const line of text.split("\n")) {
    // 快篩：`[YYYY-MM-DD…` 開頭才是今日行（垃圾行／昨日行直接跳過）。
    if (line.charCodeAt(0) !== 0x5b || line.slice(1, 11) !== today) continue;
    const entry = parseLogLine(line);
    if (!entry || !levelEnabled(entry.level)) continue;
    out.push(entry);
    if (out.length > want) out.splice(0, out.length - want);
  }
  return out;
}

/**
 * 開機回填：把今日已落檔的 log 讀回內存，重啟幾次 Dashboard 都顯示完整今日紀錄。
 * 讀本檔＋.1（容量輪替的前半段），都只取今日、只取尾巴 logLimit 筆。回傳回填筆數。
 */
export function backfillRecentLogs(): number {
  const today = nowIso().slice(0, 10);
  const want = Math.max(1, config.logLimit);
  const merged = [
    ...readTailEntries(`${config.logFile}.1`, today, want),
    ...readTailEntries(config.logFile, today, want),
  ];
  const tail = merged.slice(-want);
  buffer.length = 0;
  buffer.push(...tail);
  return tail.length;
}

export function initLogger(): void {
  try {
    mkdirSync(dirname(config.logFile), { recursive: true });
  } catch {
    // ignore
  }
  const tick = (): void => {
    rotateIfNeeded(config.logFile, config.logMaxBytes, config.logMaxFiles);
    rotateDailyIfNeeded(config.logFile, config.logMaxFiles);
  };
  tick();
  // 先輪替（跨日時舊檔已搬走，不會把昨天的讀回來），再回填今日。
  const restored = backfillRecentLogs();
  if (restored > 0) write("info", `已回填今日 log（${restored} 筆）`);
  setInterval(tick, 60_000).unref();
}
