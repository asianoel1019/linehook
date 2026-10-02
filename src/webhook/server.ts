import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import QRCode from "qrcode";
import { marked } from "marked";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getState } from "../state.js";
import { currentSettings, saveSettings } from "../settings.js";
import { getStats } from "../stats.js";
import { getTokenUsage } from "../token-stats.js";
import { listSkills, isBuiltinSkill } from "../skills/index.js";
import { resolveText } from "../skills/types.js";
import { installZip, listInstalled, uninstallSkill } from "../skills/install.js";
import { llmConfigFrom, listModels } from "../skills/llm.js";
import { LANGS, LANG_LABELS, isLang, langMap, tr, type Lang } from "../i18n.js";
import { NotLoggedInError, TargetNotFoundError, type FlexInput, type LocationInput, type SendInput, type StickerInput } from "../line/client.js";
import type { IMessagingService, Platform } from "../messaging/types.js";
import { getService, listServices } from "../messaging/services.js";
import { isDuplicateIdempotency, markIdempotency, requireSessionOrApi, verifyWebhookAuth, type RawBodyRequest } from "../middleware/hmac.js";
import { getMessages, reloadMessages, searchMessages } from "../messages.js";
import { clientIp, ipGuard, isPrivateRequest } from "../middleware/ip.js";
import { loginRateLimit, rateLimit } from "../middleware/rateLimit.js";
import { changePassword, createSession, currentUser, destroySession, hasSession, refreshSession, requireSameOrigin, requireSession, sessionRemainingMs, verifyCredentials, } from "../middleware/session.js";
import { parseCron } from "../line/cron.js";
import { parseDateTimeInTz } from "../time.js";

function statusAccess(req: Request, res: Response, next: NextFunction): void {
    if (config.adminPrivateOnly) {
        if (!isPrivateRequest(req)) {
            logger.warn("非私人 IP 存取管理頁面被拒", { ip: clientIp(req) });
            res.status(403).send("Forbidden");
            return;
        }
    }
    next();
}
function sendError(res: Response, error: unknown): void {
    if (error instanceof TargetNotFoundError) {
        res.status(404).json({ ok: false, error: error.message });
        return;
    }
    if (error instanceof NotLoggedInError) {
        res.status(503).json({ ok: false, error: error.message });
        return;
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
}
const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
const LANG_COOKIE = "lw_lang";
const LANG_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/** 讀取瀏覽器的語言偏好 cookie（僅登入頁使用，不寫入設定檔）；無效回 undefined。 */
function readLangCookie(req: Request): Lang | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index < 0) continue;
        if (part.slice(0, index).trim() !== LANG_COOKIE) continue;
        let raw = part.slice(index + 1).trim();
        try {
            raw = decodeURIComponent(raw);
        } catch {
            return undefined;
        }
        if (isLang(raw)) return raw;
        return undefined;
    }
    return undefined;
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
function parseTargets(value: unknown): string[] {
    const targets: string[] = [];
    if (typeof value === "string") {
        if (value.trim())
            targets.push(value.trim());
    }
    else if (Array.isArray(value)) {
        for (const item of value) {
            if (typeof item === "string" && item.trim())
                targets.push(item.trim());
        }
    }
    return targets;
}
function parseSticker(value: unknown): StickerInput | undefined {
    const raw = asRecord(value);
    if (!raw)
        return undefined;
    const packageId = raw.packageId ?? raw.package_id;
    const stickerId = raw.stickerId ?? raw.sticker_id;
    if (packageId === undefined || stickerId === undefined)
        return undefined;
    return {
        packageId: String(packageId),
        stickerId: String(stickerId),
        version: raw.version === undefined ? undefined : String(raw.version),
    };
}
function parseLocation(value: unknown): LocationInput | undefined {
    const raw = asRecord(value);
    if (!raw)
        return undefined;
    const latitude = Number(raw.latitude);
    const longitude = Number(raw.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
        return undefined;
    return {
        title: typeof raw.title === "string" ? raw.title : "",
        address: typeof raw.address === "string" ? raw.address : "",
        latitude,
        longitude,
    };
}
function parseFlex(value: unknown): FlexInput | undefined {
    const raw = asRecord(value);
    if (!raw)
        return undefined;
    let contents: unknown = raw.contents ?? raw.json;
    if (typeof contents === "string") {
        try {
            contents = JSON.parse(contents);
        }
        catch {
            return undefined;
        }
    }
    const record = asRecord(contents);
    if (!record)
        return undefined;
    return {
        altText: typeof raw.altText === "string" && raw.altText ? raw.altText : "Flex 訊息",
        contents: record,
    };
}
function renderTemplate(text: string, vars: Record<string, string>): string {
    return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) => Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match);
}
function parseVars(value: unknown): Record<string, string> {
    const raw = asRecord(value);
    if (!raw)
        return {};
    const vars: Record<string, string> = {};
    for (const [key, item] of Object.entries(raw)) {
        if (item === undefined || item === null)
            continue;
        vars[key] = typeof item === "string" ? item : String(item);
    }
    return vars;
}
function resolveRunAt(body: Record<string, unknown>): { runAt?: number; error?: string } {
    const delaySec = body.delaySec;
    if (delaySec !== undefined && delaySec !== null && delaySec !== "") {
        const seconds = Number(delaySec);
        if (!Number.isFinite(seconds) || seconds < 0) {
            return { error: "delaySec 必須是非負數（秒）" };
        }
        return { runAt: Date.now() + seconds * 1000 };
    }
    const sendAt = body.sendAt;
    if (sendAt === undefined || sendAt === null || sendAt === "")
        return {};
    let runAt: number;
    if (typeof sendAt === "number") {
        runAt = sendAt < 1e12 ? sendAt * 1000 : sendAt;
    }
    else if (typeof sendAt === "string") {
        const trimmed = sendAt.trim();
        const numeric = Number(trimmed);
        if (trimmed !== "" && Number.isFinite(numeric)) {
            runAt = numeric < 1e12 ? numeric * 1000 : numeric;
        }
        else {
            // 「YYYY-MM-DD HH:mm」以設定時區解讀，避免伺服器時區不同造成漂移。
            const tzParsed = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(trimmed)
                ? parseDateTimeInTz(trimmed, config.timezone)
                : null;
            if (tzParsed !== null) {
                runAt = tzParsed;
            }
            else {
                const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(trimmed)
                    ? trimmed.replace(" ", "T")
                    : trimmed;
                runAt = Date.parse(normalized);
            }
        }
    }
    else {
        return { error: "sendAt 格式錯誤" };
    }
    if (!Number.isFinite(runAt))
        return { error: "sendAt 無法解析" };
    if (runAt < Date.now() - 60_000)
        return { error: "sendAt 不可早於現在" };
    if (runAt > Date.now() + MAX_SCHEDULE_AHEAD_MS) {
        return { error: "sendAt 最遠僅支援 30 天內" };
    }
    return { runAt };
}
/** 驗證 repeat cron；無效回錯誤訊息（呼叫端回 400），避免排程器丟出後變成 500。 */
function validateRepeat(value: unknown): { repeat: string } | { error: string } {
    const repeat = typeof value === "string" ? value.trim() : "";
    if (!repeat) return { repeat: "" };
    try {
        parseCron(repeat);
    }
    catch (error) {
        return { error: error instanceof Error ? error.message : "repeat 格式錯誤" };
    }
    return { repeat };
}
function findFlexTemplate(name: string): FlexInput | undefined {
    const tpl = config.flexTemplates.find((item) => item.name === name);
    if (!tpl)
        return undefined;
    try {
        const contents = asRecord(JSON.parse(tpl.contents));
        if (!contents)
            return undefined;
        return { altText: tpl.altText || "Flex 訊息", contents };
    }
    catch {
        return undefined;
    }
}
interface ParsedMessage {
    text?: string;
    file?: string;
    image?: string;
    video?: string;
    audio?: string;
    filename?: string;
    sticker?: StickerInput;
    location?: LocationInput;
    flex?: FlexInput;
}
function buildInputFromMessage(to: string, msg: ParsedMessage): SendInput {
    return {
        to,
        text: msg.text,
        file: msg.file,
        image: msg.image,
        video: msg.video,
        audio: msg.audio,
        filename: msg.filename,
        sticker: msg.sticker,
        location: msg.location,
        flex: msg.flex,
    };
}
function parseMessage(raw: unknown): ParsedMessage | { error: string } {
    const msg = asRecord(raw) ?? {};
    const vars = parseVars(msg.vars);
    let text = typeof msg.text === "string" ? msg.text : "";
    const templateName = typeof msg.template === "string" ? msg.template.trim() : "";
    if (templateName) {
        const template = config.templates.find((item) => item.name === templateName);
        if (!template)
            return { error: `找不到模板：${templateName}` };
        if (!text)
            text = template.text;
    }
    if (text && Object.keys(vars).length > 0)
        text = renderTemplate(text, vars);
    let flex = parseFlex(msg.flex);
    const flexName = typeof msg.flexTemplate === "string" ? msg.flexTemplate.trim() : "";
    if (!flex && flexName) {
        flex = findFlexTemplate(flexName);
        if (!flex)
            return { error: `找不到 Flex 樣板：${flexName}` };
        if (Object.keys(vars).length > 0) {
            flex = {
                altText: renderTemplate(flex.altText, vars),
                contents: JSON.parse(renderTemplate(JSON.stringify(flex.contents), vars)) as Record<string, unknown>,
            };
        }
    }
    const file = typeof msg.file === "string" ? msg.file.trim() : "";
    const image = typeof msg.image === "string" ? msg.image.trim() : "";
    const video = typeof msg.video === "string" ? msg.video.trim() : "";
    const audio = typeof msg.audio === "string" ? msg.audio.trim() : "";
    const sticker = parseSticker(msg.sticker);
    const location = parseLocation(msg.location);
    if (!text && !file && !image && !video && !audio && !sticker && !location && !flex) {
        return {
            error: "訊息需提供 text / file / image / video / audio / sticker / location / flex 至少一項",
        };
    }
    return {
        text,
        file,
        image,
        video,
        audio,
        filename: typeof msg.filename === "string" ? msg.filename.trim() : "",
        sticker,
        location,
        flex,
    };
}
function resolveInputs(body: Record<string, unknown>, targets: string[]): SendInput[] | { error: string } {
    const messagesRaw = body.messages;
    if (Array.isArray(messagesRaw) && messagesRaw.length > 0) {
        const perMessage: Array<{ to?: string; parsed: ParsedMessage }> = [];
        for (const raw of messagesRaw) {
            const result = parseMessage(raw);
            if ("error" in result)
                return result;
            const record = asRecord(raw);
            const to = record && typeof record.to === "string" ? record.to.trim() : "";
            perMessage.push({ to: to || undefined, parsed: result });
        }
        if (perMessage.every((item) => item.to)) {
            return perMessage.map((item) => buildInputFromMessage(item.to as string, item.parsed));
        }
        const inputs: SendInput[] = [];
        for (const to of targets) {
            for (const item of perMessage) {
                inputs.push(buildInputFromMessage(item.to ?? to, item.parsed));
            }
        }
        return inputs;
    }
    const result = parseMessage(body);
    if ("error" in result)
        return result;
    return targets.map((to) => buildInputFromMessage(to, result));
}
const SETTINGS_STYLE = `
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0;
    padding: 32px 20px 72px;
    color: #e5e7eb;
    font-family: system-ui, "Segoe UI", sans-serif;
    background: linear-gradient(135deg, #581c87 0%, #9d174d 50%, #312e81 100%);
    background-size: 200% 200%;
    background-attachment: fixed;
    animation: bgShift 20s ease infinite;
    overflow-x: hidden;
  }
  @keyframes bgShift { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
  body::before {
    content: "";
    position: fixed; inset: 0;
    background-image:
      linear-gradient(rgba(34,211,238,0.08) 1px, transparent 1px),
      linear-gradient(90deg, rgba(34,211,238,0.08) 1px, transparent 1px);
    background-size: 50px 50px;
    pointer-events: none; z-index: 0;
  }
  .shell { position: relative; z-index: 2; max-width: 1180px; margin: 0 auto; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 22px; align-items: start; }
  .shell.solo { grid-template-columns: minmax(0, 1fr); }
  .sidebar { position: sticky; top: 24px; display: flex; flex-direction: column; gap: 14px; align-items: flex-start; min-height: calc(100vh - 48px); }
  .brand { font-size: 20px; font-weight: 800; letter-spacing: .04em; padding: 2px 6px; }
  .content { min-width: 0; }

  .geo { position: fixed; z-index: 1; pointer-events: none; }
  .geo-circle { width: 32px; height: 32px; border-radius: 50%; background: #22d3ee; box-shadow: 0 0 28px #22d3ee; top: 12%; left: 6%; animation: geoBounce 3s ease-in-out infinite; }
  .geo-square { width: 24px; height: 24px; background: #f472b6; box-shadow: 0 0 22px #f472b6; top: 72%; left: 88%; animation: geoSpin 4s linear infinite; }
  .geo-ring { width: 20px; height: 20px; border-radius: 50%; border: 2px solid #67e8f9; top: 28%; left: 82%; animation: geoPing 2s cubic-bezier(0,0,0.2,1) infinite; }
  @keyframes geoBounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-24px); } }
  @keyframes geoSpin { to { transform: rotate(360deg); } }
  @keyframes geoPing { 0% { transform: scale(1); opacity: .9; } 75%,100% { transform: scale(2.4); opacity: 0; } }
  @keyframes hue { to { filter: hue-rotate(360deg); } }

  h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: .02em; }
  h2 { font-size: 15px; margin: 28px 0 12px; text-transform: uppercase; letter-spacing: .12em; color: #a5f3fc; }
  .neon-text { background: linear-gradient(90deg, #22d3ee, #f472b6, #818cf8); -webkit-background-clip: text; background-clip: text; color: transparent; filter: drop-shadow(0 0 10px rgba(34,211,238,.35)); }
  .hue { animation: hue 8s linear infinite; }

  nav { display: flex; flex-direction: column; gap: 8px; }
  nav a { color: #a5f3fc; text-decoration: none; padding: 9px 14px; border-radius: 10px; border: 1px solid rgba(34,211,238,.25); background: rgba(0,0,0,.3); transition: all .3s ease; display: block; text-align: center; }
  nav a:hover { transform: translateX(3px); background: rgba(34,211,238,.2); box-shadow: 0 0 18px rgba(34,211,238,.5); }
  nav a.active { font-weight: 700; background: linear-gradient(90deg, rgba(34,211,238,.35), rgba(244,114,182,.35)); }
  nav .logout { margin-top: 4px; width: 100%; }
  .side-section { font-size: 11px; text-transform: uppercase; letter-spacing: .14em; color: #94a3b8; margin: 14px 4px 0; padding-top: 12px; border-top: 1px solid rgba(34,211,238,.15); align-self: stretch; }
  .side-section:first-child { margin-top: 0; padding-top: 0; border-top: none; }
  .fn-list { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
  .fn-card { text-align: center; width: 100%; padding: 9px 14px; border-radius: 4px 10px 10px 4px; border: 1px solid rgba(34,211,238,.3); border-left: 3px solid rgba(34,211,238,.75); background: linear-gradient(90deg, rgba(34,211,238,.1), rgba(0,0,0,.3)); color: #a5f3fc; font-weight: 600; cursor: pointer; transition: all .25s ease; }
  .fn-card:hover { transform: translateX(3px); background: linear-gradient(90deg, rgba(34,211,238,.22), rgba(0,0,0,.3)); box-shadow: 0 0 16px rgba(34,211,238,.4); }
  .fn-card.active { color: #e0f2fe; background: linear-gradient(90deg, rgba(34,211,238,.45), rgba(34,211,238,.12)); border-color: transparent; border-left: 3px solid #22d3ee; box-shadow: 0 0 18px rgba(34,211,238,.5); }
  .fn-card.setting { color: #fbcfe8; border: 1px solid rgba(244,114,182,.3); border-left: 3px solid rgba(244,114,182,.75); border-radius: 4px 10px 10px 4px; background: linear-gradient(90deg, rgba(244,114,182,.08), rgba(0,0,0,.3)); }
  .fn-card.setting:hover { background: linear-gradient(90deg, rgba(244,114,182,.2), rgba(0,0,0,.3)); box-shadow: 0 0 16px rgba(244,114,182,.4); }
  .fn-card.setting.active { color: #fff; background: linear-gradient(90deg, rgba(244,114,182,.45), rgba(129,140,248,.25)); border-color: transparent; border-left: 3px solid #f472b6; box-shadow: 0 0 20px rgba(244,114,182,.5); }
  .plat-off { display: none !important; }
  .platform-switch { display: flex; gap: 6px; margin: 0 0 4px; }
  .platform-switch button { flex: 1; padding: 7px 10px; font-size: 12px; font-weight: 700; border-radius: 999px; border: 1px solid rgba(34,211,238,.3); background: rgba(0,0,0,.3); color: #a5f3fc; cursor: pointer; transition: all .25s ease; }
  .platform-switch button:hover { box-shadow: 0 0 14px rgba(34,211,238,.4); }
  .platform-switch button.active { color: #fff; border-color: transparent; background: linear-gradient(90deg, rgba(34,211,238,.45), rgba(244,114,182,.35)); box-shadow: 0 0 16px rgba(34,211,238,.45); }
  .platform-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .platform-chips button { padding: 6px 12px; font-size: 12px; font-weight: 600; border-radius: 999px; border: 1px solid rgba(34,211,238,.35); background: rgba(0,0,0,.3); color: #a5f3fc; cursor: pointer; }
  .platform-chips button:hover { box-shadow: 0 0 12px rgba(34,211,238,.4); }
  .platform-chips button.active { color: #fff; border-color: transparent; background: linear-gradient(90deg, rgba(34,211,238,.45), rgba(244,114,182,.3)); }
  #platform-blocks [data-platform].active { border-left: 3px solid #22d3ee; box-shadow: 0 0 22px rgba(34,211,238,.28); }
  .user-dock { margin-top: auto; padding-top: 14px; position: relative; }
  .lang-dock { position: relative; margin-bottom: 8px; }
  .lang-toggle { padding: 4px 12px; font-size: 12px; border-radius: 999px; border: 1px solid rgba(34,211,238,.35); background: rgba(0,0,0,.3); color: #a5f3fc; cursor: pointer; }
  .lang-toggle:hover { transform: none; box-shadow: 0 0 12px rgba(34,211,238,.45); }
  .lang-menu { position: absolute; bottom: 34px; left: 0; z-index: 30; display: flex; flex-direction: column; gap: 2px; min-width: 110px; padding: 6px; background: rgba(15,10,40,.97); border: 1px solid rgba(34,211,238,.35); border-radius: 12px; box-shadow: 0 12px 28px rgba(0,0,0,.5), 0 0 18px rgba(34,211,238,.25); backdrop-filter: blur(10px); }
  .lang-menu[hidden] { display: none; }
  .lang-btn { padding: 7px 10px; font-size: 12px; text-align: left; border-radius: 8px; border: none; background: transparent; color: #cbd5e1; cursor: pointer; }
  .lang-btn:hover { transform: none; box-shadow: none; background: linear-gradient(90deg, rgba(34,211,238,.28), rgba(244,114,182,.28)); }
  .lang-btn.active { font-weight: 700; color: #fff; background: linear-gradient(90deg, rgba(34,211,238,.4), rgba(244,114,182,.3)); }
  .user-countdown { font-size: 12px; color: #94a3b8; font-variant-numeric: tabular-nums; letter-spacing: .06em; margin-bottom: 6px; }
  .user-avatar { width: 42px; height: 42px; padding: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 17px; font-weight: 800; text-transform: uppercase; color: #0b1020; background: linear-gradient(135deg, #22d3ee, #f472b6); border: none; box-shadow: 0 0 18px rgba(34,211,238,.55); }
  .user-avatar:hover { transform: scale(1.08); box-shadow: 0 0 24px rgba(244,114,182,.7); }
  .user-menu { position: absolute; bottom: 60px; left: 0; min-width: 150px; display: flex; flex-direction: column; gap: 4px; padding: 6px; z-index: 20; background: rgba(15,10,40,.96); border: 1px solid rgba(34,211,238,.35); border-radius: 14px; box-shadow: 0 12px 28px rgba(0,0,0,.5), 0 0 20px rgba(34,211,238,.25); backdrop-filter: blur(10px); }
  .user-menu[hidden] { display: none; }
  .user-menu button { text-align: left; width: 100%; padding: 9px 12px; border: none; border-radius: 9px; background: transparent; color: #e2e8f0; font-weight: 600; }
  .user-menu button:hover { background: linear-gradient(90deg, rgba(34,211,238,.25), rgba(244,114,182,.25)); box-shadow: none; transform: none; }
  .content { position: relative; }
  .im-switch { position: absolute; top: 0; right: 0; z-index: 25; }
  .im-switch-btn { display: flex; align-items: center; gap: 7px; padding: 7px 13px; font-size: 12px; font-weight: 700; border-radius: 999px; border: 1px solid rgba(34,211,238,.35); background: rgba(0,0,0,.35); color: #a5f3fc; cursor: pointer; }
  .im-switch-btn:hover { box-shadow: 0 0 14px rgba(34,211,238,.45); }
  .im-switch-dot { width: 8px; height: 8px; border-radius: 50%; background: #22d3ee; box-shadow: 0 0 8px #22d3ee; }
  .im-switch-menu { position: absolute; top: 38px; right: 0; z-index: 30; display: flex; flex-direction: column; gap: 2px; min-width: 150px; padding: 6px; background: rgba(15,10,40,.97); border: 1px solid rgba(34,211,238,.35); border-radius: 12px; box-shadow: 0 12px 28px rgba(0,0,0,.5), 0 0 18px rgba(34,211,238,.25); backdrop-filter: blur(10px); }
  .im-switch-menu[hidden] { display: none; }
  .im-switch-menu button { text-align: left; padding: 8px 10px; font-size: 13px; border-radius: 8px; border: none; background: transparent; color: #cbd5e1; cursor: pointer; }
  .im-switch-menu button:hover { background: linear-gradient(90deg, rgba(34,211,238,.28), rgba(244,114,182,.28)); }
  .im-switch-menu button.active { font-weight: 700; color: #fff; background: linear-gradient(90deg, rgba(34,211,238,.4), rgba(244,114,182,.3)); }
  .modal-backdrop { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.62); backdrop-filter: blur(3px); }
  .modal-backdrop[hidden] { display: none; }
  .modal { width: min(430px, 92vw); margin: 0; }
  .modal .field { grid-template-columns: 1fr; gap: 4px 0; }
  .modal .field label { font-size: 13px; color: #a5f3fc; }
  .modal input { width: 100%; min-width: 0; box-sizing: border-box; }
  .stat-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .stat-card { text-align: center; padding: 12px 8px; border-radius: 12px; border: 1px solid rgba(34,211,238,.25); background: rgba(0,0,0,.28); }
  .stat-num { font-size: 24px; font-weight: 800; color: #a5f3fc; }
  .stat-label { font-size: 12px; color: #94a3b8; margin-top: 2px; }
  .chart { display: flex; align-items: flex-end; gap: 6px; height: 130px; margin-top: 14px; }
  .chart-col { flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 0; }
  .chart-stack { display: flex; flex-direction: column; justify-content: flex-end; width: 100%; height: 100px; }
  .chart-bar { width: 100%; border-radius: 4px 4px 0 0; }
  .chart-bar.ok { background: linear-gradient(180deg, #22d3ee, #0891b2); }
  .chart-bar.fail { background: linear-gradient(180deg, #f43f5e, #9f1239); }
  .chart-label { font-size: 10px; color: #94a3b8; margin-top: 4px; white-space: nowrap; }
  .dash-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  #skillList { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
  @media (max-width: 900px) { #skillList { grid-template-columns: 1fr; } }
  .skill-card { margin: 0; border-left: 3px solid #22d3ee; align-self: start; }
  .skill-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .skill-desc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .skill-card.open { grid-column: 1 / -1; }
  .sk-toggle { padding: 2px 10px; font-size: 14px; line-height: 1.4; border-radius: 8px; }
  .skill-body { margin-top: 12px; }
  .skill-body[hidden] { display: none; }
  .skill-body .field input, .skill-body .field select, .skill-body .field textarea { max-width: 560px; }
  .fn-panel { display: none; }
  .fn-panel.active { display: block; }
  @media (max-width: 820px) {
    .shell { grid-template-columns: 1fr; }
    .sidebar { position: static; }
    nav { flex-direction: row; flex-wrap: wrap; }
    nav .logout { width: auto; margin-top: 0; margin-left: auto; }
    .fn-list { flex-direction: row; flex-wrap: wrap; }
    .fn-card { width: auto; }
    .platform-switch { width: 100%; }
    .side-section { width: 100%; }
    .stat-cards { grid-template-columns: repeat(2, 1fr); }
    .dash-grid { grid-template-columns: 1fr; }
  }
  .login-center { min-height: 82vh; display: flex; align-items: center; justify-content: center; }
  .login-card { max-width: 380px; width: 100%; text-align: center; }
  .login-head { display: flex; align-items: center; justify-content: center; position: relative; margin-bottom: 6px; }
  .login-head h2 { margin: 0; }
  .login-lang { position: absolute; right: 0; }
  .login-lang-toggle { padding: 3px 9px; font-size: 11px; line-height: 1.4; border: 1px solid rgba(34,211,238,.3); border-radius: 999px; background: rgba(0,0,0,.3); color: #7dd3fc; cursor: pointer; font-weight: 600; }
  .login-lang-toggle:hover { transform: none; box-shadow: 0 0 10px rgba(34,211,238,.4); background: rgba(34,211,238,.15); }
  .login-lang-menu { position: absolute; top: 26px; right: 0; z-index: 20; display: flex; flex-direction: column; gap: 2px; min-width: 96px; padding: 5px; background: rgba(15,10,40,.97); border: 1px solid rgba(34,211,238,.35); border-radius: 10px; box-shadow: 0 12px 28px rgba(0,0,0,.5), 0 0 16px rgba(34,211,238,.25); backdrop-filter: blur(10px); text-align: left; }
  .login-lang-menu[hidden] { display: none; }
  .login-lang-item { padding: 6px 9px; font-size: 12px; text-align: left; border: none; border-radius: 7px; background: transparent; color: #cbd5e1; cursor: pointer; font-weight: 600; }
  .login-lang-item:hover { transform: none; box-shadow: none; background: linear-gradient(90deg, rgba(34,211,238,.28), rgba(244,114,182,.28)); }
  .login-lang-item.active { color: #fff; background: linear-gradient(90deg, rgba(34,211,238,.4), rgba(244,114,182,.3)); }
  .login-card h2 { margin: 0 0 6px; text-transform: none; letter-spacing: 0; font-size: 22px; }
  .login-card .sub { color: #94a3b8; font-size: 13px; margin-bottom: 22px; }
  .login-card input { width: 100%; margin-bottom: 12px; text-align: center; }
  .login-card button[type="submit"] { width: 100%; margin-top: 4px; }

  .glass { background: rgba(0,0,0,0.4); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(34,211,238,0.3); border-radius: 16px; box-shadow: 0 10px 15px -3px rgba(34,211,238,0.25), inset 0 0 24px rgba(34,211,238,0.08); padding: 16px 20px; margin: 14px 0; }
  .glass-hover { position: relative; overflow: hidden; transition: transform .5s ease, background-color .5s ease, box-shadow .5s ease; }
  .glass-hover:hover { transform: scale(1.05); background: rgba(0,0,0,0.35); box-shadow: 0 20px 30px -6px rgba(34,211,238,0.35), inset 0 0 32px rgba(244,114,182,0.12); }
  .glass-hover::after { content: ""; position: absolute; top: 0; left: -150%; width: 60%; height: 100%; background: linear-gradient(120deg, transparent, rgba(255,255,255,0.18), transparent); transform: skewX(-20deg); pointer-events: none; }
  .glass-hover:hover::after { animation: shimmer 1s ease; }
  @keyframes shimmer { 0% { left: -150%; } 100% { left: 150%; } }

  .badge { display: inline-block; padding: 5px 16px; border-radius: 999px; font-weight: 800; color: #0b1020; background: linear-gradient(90deg, #22d3ee, #f472b6); box-shadow: 0 0 22px rgba(34,211,238,.6); animation: hue 8s linear infinite; letter-spacing: .04em; }
  .badge.ok { background: linear-gradient(90deg, #34d399, #22d3ee); }
  .badge.bad { background: linear-gradient(90deg, #f43f5e, #f472b6); }
  .badge.warn { background: linear-gradient(90deg, #fbbf24, #f472b6); }

  .actions { margin: 14px 0; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  button { padding: 9px 18px; border: 1px solid rgba(34,211,238,.5); border-radius: 10px; cursor: pointer; color: #e0f2fe; background: rgba(34,211,238,.12); font-weight: 600; transition: all .5s ease; }
  button:hover { transform: scale(1.05); background: linear-gradient(90deg, rgba(34,211,238,.4), rgba(244,114,182,.4)); box-shadow: 0 0 22px rgba(34,211,238,.55); }
  input, select { padding: 9px 12px; border-radius: 10px; color: #e5e7eb; background: rgba(0,0,0,.35); border: 1px solid rgba(34,211,238,.3); outline: none; transition: all .5s ease; font-family: inherit; }
  .icon-btn { padding: 8px 12px; font-size: 16px; line-height: 1; }
  input::placeholder, textarea::placeholder { color: #94a3b8; }
  input:focus, select:focus, textarea:focus { border-color: #22d3ee; box-shadow: 0 0 0 2px rgba(34,211,238,.3), 0 0 18px rgba(34,211,238,.35); }
  input[type="checkbox"] {
    appearance: none; -webkit-appearance: none;
    width: 20px; height: 20px; padding: 0; margin: 0;
    justify-self: start;
    border: 1px solid rgba(34,211,238,.5);
    border-radius: 6px;
    background: rgba(0,0,0,.35);
    cursor: pointer;
    position: relative;
    display: inline-block;
    vertical-align: middle;
    transition: all .3s ease;
  }
  input[type="checkbox"]:hover { box-shadow: 0 0 12px rgba(34,211,238,.5); }
  input[type="checkbox"]:focus { border-color: #22d3ee; box-shadow: 0 0 0 2px rgba(34,211,238,.35); }
  input[type="checkbox"]:checked {
    background: linear-gradient(135deg, #22d3ee, #f472b6);
    border-color: transparent;
    box-shadow: 0 0 14px rgba(34,211,238,.6);
  }
  input[type="checkbox"]::after {
    content: "";
    position: absolute;
    left: 6px; top: 2px;
    width: 5px; height: 10px;
    border: solid #0b1020;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
    opacity: 0;
    transition: opacity .2s ease;
  }
  input[type="checkbox"]:checked::after { opacity: 1; }
  select option { background: #1e1b4b; color: #e5e7eb; }
  input[type="datetime-local"] { color: #e5e7eb; }
  textarea { padding: 9px 12px; border-radius: 10px; color: #e5e7eb; background: rgba(0,0,0,.35); border: 1px solid rgba(34,211,238,.3); width: 100%; min-height: 84px; font-family: ui-monospace, Consolas, monospace; font-size: 13px; outline: none; transition: all .5s ease; }
  form.inline { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }

  table { border-collapse: separate; border-spacing: 0; width: 100%; margin: 8px 0; }
  th, td { padding: 8px 12px; text-align: left; font-size: 14px; vertical-align: top; border-bottom: 1px solid rgba(34,211,238,.15); }
  th { color: #67e8f9; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
  tbody tr { transition: background-color .5s ease; }
  tbody tr:hover { background: rgba(34,211,238,.06); }
  table.kv th { width: 220px; }
  table.targets-table td:first-child { white-space: nowrap; }
  td.actions-cell { white-space: nowrap; }
  td.actions-cell button { padding: 6px 12px; }
  td.actions-cell button + button { margin-left: 6px; }
  .mono, code { font-size: 12px; word-break: break-all; font-family: ui-monospace, Consolas, monospace; color: #a5f3fc; }
  .lv-error { color: #fb7185; font-weight: 700; }
  .lv-warn { color: #fbbf24; font-weight: 700; }
  .lv-info { color: #34d399; }
  .msg { font-size: 13px; color: #cbd5e1; }

  fieldset { border: 1px solid rgba(34,211,238,.3); border-radius: 16px; margin: 0 0 16px; padding: 14px 18px; background: rgba(0,0,0,.4); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); box-shadow: 0 10px 15px -3px rgba(34,211,238,.2), inset 0 0 24px rgba(34,211,238,.06); transition: all .5s ease; }
  fieldset:hover { border-color: rgba(34,211,238,.55); box-shadow: 0 16px 26px -6px rgba(34,211,238,.3), inset 0 0 28px rgba(244,114,182,.1); }
  legend { font-weight: 700; padding: 0 8px; color: #67e8f9; letter-spacing: .06em; }
  .field { display: grid; grid-template-columns: 240px 1fr; gap: 8px 12px; align-items: center; margin-bottom: 10px; }
  .field .hint { grid-column: 2; font-size: 12px; color: #94a3b8; }
  .auth-box { border: 1px solid rgba(244,114,182,.3); border-radius: 12px; margin: 0 0 12px; padding: 12px 14px 2px; background: rgba(0,0,0,.25); }
  .auth-box-title { font-weight: 700; margin-bottom: 10px; color: #f0abfc; letter-spacing: .04em; }
  details { margin: 12px 0; }
  summary { cursor: pointer; font-weight: 700; color: #67e8f9; padding: 6px 0; }
  a { color: #67e8f9; }
  .md h1 { font-size: 24px; margin: 4px 0 14px; }
  .md h2 { font-size: 17px; margin: 26px 0 10px; text-transform: none; letter-spacing: 0; color: #a5f3fc; border-bottom: 1px solid rgba(34,211,238,.2); padding-bottom: 6px; }
  .md h3 { font-size: 15px; margin: 20px 0 8px; color: #c4b5fd; }
  .md p, .md li { line-height: 1.75; color: #dbeafe; }
  .md ul, .md ol { padding-left: 22px; }
  .md code { background: rgba(34,211,238,.14); padding: 2px 6px; border-radius: 6px; color: #a5f3fc; }
  .md pre { background: rgba(0,0,0,.5); border: 1px solid rgba(34,211,238,.25); border-radius: 12px; padding: 14px; overflow-x: auto; box-shadow: inset 0 0 20px rgba(34,211,238,.08); }
  .md pre code { background: none; padding: 0; }
  .md blockquote { border-left: 3px solid #22d3ee; margin: 14px 0; padding: 6px 14px; color: #cbd5e1; background: rgba(34,211,238,.06); border-radius: 0 8px 8px 0; }
  .md hr { border: none; border-top: 1px solid rgba(34,211,238,.25); margin: 22px 0; }
  .md img { max-width: 100%; }
  .md a { color: #67e8f9; }
`;
function page(
    title: string,
    active: string,
    body: string,
    script: string,
    options: { showNav?: boolean; sidebar?: string; showTitle?: boolean; lang?: Lang } = {},
): string {
    const showNav = options.showNav ?? true;
    const showTitle = options.showTitle ?? true;
    const lang = options.lang ?? config.language;
    const nav = [
        ["/dashboard", tr(lang, "nav_dashboard"), "dashboard"],
        ["/console", tr(lang, "nav_console"), "console"],
        ["/skills", tr(lang, "nav_skills"), "skills"],
        ["/settings", tr(lang, "nav_settings"), "settings"],
        ["/messages", tr(lang, "nav_messages"), "messages"],
        ["/readme", tr(lang, "nav_readme"), "readme"],
    ]
        .map(([href, label, key]) => `<a href="${href}" class="${key === active ? "active" : ""}">${label}</a>`)
        .join("");
    const username = currentUser();
    const initial = (username.trim()[0] || "?").toUpperCase();
    const esc = (value: string): string => value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const langSwitcher = showNav
        ? `<div class="lang-dock">
<button type="button" class="lang-toggle" id="lang-toggle">${LANG_LABELS[lang]}</button>
<div class="lang-menu" id="lang-menu" hidden>${LANGS.map((code) => `<button type="button" class="lang-btn${code === lang ? " active" : ""}" data-lang="${code}">${LANG_LABELS[code]}</button>`).join("")}</div>
</div>`
        : "";
    const userDock = showNav
        ? `<div class="user-dock">
<div class="user-countdown" id="user-countdown" title="${esc(tr(lang, "idle_logout"))}">05:00</div>
${langSwitcher}
<button type="button" class="user-avatar" id="user-avatar" title="${esc(username)}">${esc(initial)}</button>
<div class="user-menu" id="user-menu" hidden>
  <button type="button" id="menu-password">${tr(lang, "change_password")}</button>
  <button type="button" id="menu-logout">${tr(lang, "logout")}</button>
</div>
</div>`
        : "";
    const sidebar = showNav
        ? `<aside class="sidebar">
<div class="brand neon-text">LINE Webhook</div>
<nav>${nav}</nav>
${options.sidebar ?? ""}
${userDock}
</aside>`
        : "";
    // 右上角全域 IM 切換：所有管理頁共用（localStorage: lw_platform）。
    const imOptions = [
        { id: "line", label: tr(lang, "platform_line") },
        { id: "telegram", label: tr(lang, "platform_telegram") },
    ];
    const imSwitch = showNav
        ? `<div class="im-switch" id="im-switch">
<button type="button" class="im-switch-btn" id="im-switch-btn"><span class="im-switch-dot"></span><span id="im-switch-label">${esc(imOptions[0].label)}</span></button>
<div class="im-switch-menu" id="im-switch-menu" hidden>
${imOptions.map((p) => `<button type="button" data-platform="${p.id}">${esc(p.label)}</button>`).join("")}
</div>
</div>`
        : "";
    const imSwitchScript = showNav
        ? `
(function () {
  var KEY = "lw_platform";
  var options = ${JSON.stringify(imOptions)};
  var ids = options.map(function (o) { return o.id; });
  var labelOf = {};
  options.forEach(function (o) { labelOf[o.id] = o.label; });
  var current = null;
  try { current = localStorage.getItem(KEY); } catch (e) {}
  if (ids.indexOf(current) === -1) current = ids[0];
  window.LW_PLATFORM = current;
  function paint() {
    var label = document.getElementById("im-switch-label");
    if (label) label.textContent = labelOf[current] || current;
    document.querySelectorAll("#im-switch-menu button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-platform") === current);
    });
  }
  paint();
  if (typeof window.onPlatformChange === "function") window.onPlatformChange(current);
  var btn = document.getElementById("im-switch-btn");
  var menu = document.getElementById("im-switch-menu");
  if (btn && menu) {
    btn.addEventListener("click", function (e) { e.stopPropagation(); menu.hidden = !menu.hidden; });
    menu.addEventListener("click", function (e) { e.stopPropagation(); });
    document.addEventListener("click", function () { menu.hidden = true; });
    menu.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        current = b.getAttribute("data-platform");
        try { localStorage.setItem(KEY, current); } catch (e) {}
        window.LW_PLATFORM = current;
        paint();
        menu.hidden = true;
        if (typeof window.onPlatformChange === "function") window.onPlatformChange(current);
      });
    });
  }
})();
`
        : "";
    const modal = showNav
        ? `<div class="modal-backdrop" id="password-modal" hidden>
<div class="glass modal">
  <h2 style="margin-top:0">${tr(lang, "change_password")}</h2>
  <div class="field"><label>${tr(lang, "pw_current")}</label><input id="pw-current" type="password" autocomplete="current-password"></div>
  <div class="field"><label>${tr(lang, "pw_new")}</label><input id="pw-new" type="password" autocomplete="new-password"></div>
  <div class="field"><label>${tr(lang, "pw_confirm")}</label><input id="pw-confirm" type="password" autocomplete="new-password"></div>
  <p id="pw-msg" class="msg"></p>
  <div class="actions"><button type="button" id="pw-cancel">${tr(lang, "pw_cancel")}</button><button type="button" id="pw-save">${tr(lang, "pw_save")}</button></div>
</div>
</div>`
        : "";
    const dictJson = JSON.stringify(langMap(lang)).replace(/</g, "\\u003c");
    return `<!doctype html>
<html lang="${lang === "zh" ? "zh-Hant" : lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LineHook</title>
<style>${SETTINGS_STYLE}</style>
</head>
<body>
<div class="geo geo-circle"></div>
<div class="geo geo-square"></div>
<div class="geo geo-ring"></div>
<div class="shell${showNav ? "" : " solo"}">
${sidebar}
<main class="content">
${imSwitch}
${showTitle ? `<h1 class="neon-text">${title}</h1>` : ""}
${body}
</main>
</div>
${modal}
<script>
var __LANG = ${JSON.stringify(lang)};
var __DICT = ${dictJson};
function T(k) { return (__DICT && __DICT[k]) || k; }
function applyI18n() {
  Array.prototype.forEach.call(document.querySelectorAll("[data-i18n]"), function (el) {
    var k = el.getAttribute("data-i18n");
    if (__DICT && __DICT[k]) el.textContent = __DICT[k];
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-ph]"), function (el) {
    var k = el.getAttribute("data-i18n-ph");
    if (__DICT && __DICT[k]) el.placeholder = __DICT[k];
  });
}
${script}${showNav ? USER_SCRIPT : ""}
${imSwitchScript}
applyI18n();
</script>
</body>
</html>`;
}
const HELPERS = `
  var $ = function (id) { return document.getElementById(id); };
  function td(text, className) {
    var el = document.createElement("td");
    el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function tr() {
    var row = document.createElement("tr");
    for (var i = 0; i < arguments.length; i++) row.appendChild(arguments[i]);
    return row;
  }
  function emptyRow(cols) {
    var cell = document.createElement("td");
    cell.colSpan = cols;
    cell.textContent = (typeof T === "function") ? T("no_data") : "尚無資料";
    return tr(cell);
  }
  function post(path, body) {
    var url = path.charAt(0) === "/" ? path : "/" + path;
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      if (res.status === 401) { window.location.href = "/login"; }
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, data: data };
      });
    });
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }
`;
const USER_SCRIPT = `
  (function () {
    var avatar = document.getElementById("user-avatar");
    var menu = document.getElementById("user-menu");
    if (avatar && menu) {
      avatar.addEventListener("click", function (e) {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
      });
      menu.addEventListener("click", function (e) { e.stopPropagation(); });
      document.addEventListener("click", function () { menu.hidden = true; });

      var logout = document.getElementById("menu-logout");
      if (logout) {
        logout.addEventListener("click", function () {
          fetch("/logout", { method: "POST" })
            .then(function () { window.location.href = "/login"; })
            .catch(function () { window.location.href = "/login"; });
        });
      }

      var modal = document.getElementById("password-modal");
      var pwMsg = document.getElementById("pw-msg");
      var open = document.getElementById("menu-password");
      if (modal && open) {
        open.addEventListener("click", function () {
          menu.hidden = true;
          pwMsg.textContent = "";
          document.getElementById("pw-current").value = "";
          document.getElementById("pw-new").value = "";
          document.getElementById("pw-confirm").value = "";
          modal.hidden = false;
          document.getElementById("pw-current").focus();
        });
        document.getElementById("pw-cancel").addEventListener("click", function () { modal.hidden = true; });
        modal.addEventListener("click", function (e) { if (e.target === modal) modal.hidden = true; });
        document.getElementById("pw-save").addEventListener("click", function () {
          var current = document.getElementById("pw-current").value;
          var next = document.getElementById("pw-new").value;
          var confirm = document.getElementById("pw-confirm").value;
          if (next !== confirm) { pwMsg.textContent = "兩次輸入的新密碼不一致"; return; }
          pwMsg.textContent = "儲存中…";
          fetch("/settings/password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ current: current, next: next })
          }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
              return { ok: res.ok, status: res.status, data: data };
            });
          }).then(function (r) {
            if (r.status === 401) { window.location.href = "/login"; return; }
            if (!r.ok) { pwMsg.textContent = "失敗：" + (r.data.error || ""); return; }
            pwMsg.textContent = "已更新密碼";
            setTimeout(function () { modal.hidden = true; }, 800);
          }).catch(function () { pwMsg.textContent = "失敗"; });
        });
      }
    }

    var countdownEl = document.getElementById("user-countdown");
    var deadline = 0;
    var haveDeadline = false;

    function setRemaining(ms) {
      deadline = Date.now() + ms;
      haveDeadline = true;
    }

    function refreshCountdown() {
      if (!countdownEl || !haveDeadline) return null;
      var remain = deadline - Date.now();
      if (remain < 0) remain = 0;
      var total = Math.ceil(remain / 1000);
      countdownEl.textContent = ("0" + Math.floor(total / 60)).slice(-2) + ":" + ("0" + (total % 60)).slice(-2);
      return remain;
    }

    function syncSession() {
      fetch("/settings/session", { cache: "no-store" })
        .then(function (res) {
          if (res.status === 401) { window.location.href = "/login"; return null; }
          return res.ok ? res.json() : null;
        })
        .then(function (data) {
          if (data && typeof data.remainingMs === "number") setRemaining(data.remainingMs);
        })
        .catch(function () {});
    }

    var lastTouch = 0;
    function touchSession() {
      var now = Date.now();
      if (now - lastTouch < 60000) return;
      lastTouch = now;
      fetch("/settings/touch", { method: "POST" })
        .then(function (res) {
          if (res.status === 401) { window.location.href = "/login"; return null; }
          if (!res.ok) { lastTouch = 0; return null; }
          return res.json();
        })
        .then(function (data) {
          if (data && typeof data.remainingMs === "number") setRemaining(data.remainingMs);
          else if (data === null) lastTouch = 0;
        })
        .catch(function () { lastTouch = 0; });
    }

    ["click", "keydown", "input"].forEach(function (ev) {
      document.addEventListener(ev, touchSession, { passive: true });
    });

    setInterval(function () {
      var remain = refreshCountdown();
      if (remain !== null && remain <= 0) syncSession();
    }, 1000);
    setInterval(syncSession, 30000);
    syncSession();

    Array.prototype.forEach.call(document.querySelectorAll(".lang-btn"), function (btn) {
      btn.addEventListener("click", function () {
        var lang = btn.getAttribute("data-lang");
        fetch("/settings/language", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lang: lang })
        }).then(function () { window.location.reload(); })
          .catch(function () { window.location.reload(); });
      });
    });

    var langToggle = document.getElementById("lang-toggle");
    var langMenu = document.getElementById("lang-menu");
    if (langToggle && langMenu) {
      langToggle.addEventListener("click", function (e) {
        e.stopPropagation();
        langMenu.hidden = !langMenu.hidden;
      });
      langMenu.addEventListener("click", function (e) { e.stopPropagation(); });
      document.addEventListener("click", function () { langMenu.hidden = true; });
    }
  })();
`;
const SESSION_SCRIPT = `
  function showSection(fn, configSections) {
    Array.prototype.forEach.call(document.querySelectorAll(".fn-card"), function (card) {
      card.classList.toggle("active", card.getAttribute("data-fn") === fn);
    });

    var form = document.getElementById("settings-form");
    Array.prototype.forEach.call(document.querySelectorAll(".fn-panel[data-fn]"), function (el) {
      el.classList.remove("active");
    });

    if (configSections && configSections.indexOf(fn) !== -1 && form) {
      form.classList.add("active");
      Array.prototype.forEach.call(form.querySelectorAll("fieldset[data-fn]"), function (fs) {
        fs.classList.toggle("active", fs.getAttribute("data-fn") === fn);
      });
      return;
    }

    if (form) form.classList.remove("active");
    var target = document.querySelector('.fn-panel[data-fn="' + fn + '"]:not(form)');
    if (target) target.classList.add("active");
  }
  function setupCards(configSections, defaultFn) {
    Array.prototype.forEach.call(document.querySelectorAll(".fn-card[data-fn]"), function (card) {
      card.addEventListener("click", function () {
        showSection(card.getAttribute("data-fn"), configSections);
      });
    });
    showSection(defaultFn, configSections);
  }
`;
function renderDashboardHtml() {
    const body = `
<div><span id="badge" class="badge">-</span></div>
<div id="platforms" class="platform-chips" style="margin-top:10px"></div>
<div id="qrbox" style="display:none">
  <p><b>請用手機 LINE 的掃描功能掃描：</b></p>
  <img id="qrimg" alt="LINE QR" style="width:280px;height:280px;background:#fff;border:1px solid #ddd;padding:8px">
  <div id="qrlink" class="msg"></div>
</div>
<div id="verify"></div>
<div id="platform-blocks"></div>

<div class="dash-grid">
  <div class="glass">
    <h2 style="margin-top:0" data-i18n="recent_title">最近發送 / 紀錄</h2>
    <table><thead><tr><th>時間</th><th>等級</th><th>訊息</th></tr></thead><tbody id="logs"></tbody></table>
  </div>
</div>
`;
    const script = `
  ${HELPERS}
  var qrBox = $("qrbox");
  var qrImg = $("qrimg");
  var qrLink = $("qrlink");
  var lastQr = "";
  var dashPlatform = window.LW_PLATFORM || "line";

  function platformLabel(p) { return T("platform_" + p) || p; }

  function summaryRows(state, queue) {
    return [
      [T("sum_status"), state.status || "-"],
      [T("sum_queue"), String(queue.pending) + (queue.running ? "（" + T("sending") + "）" : "")],
      [T("sum_last_send"), state.lastSendAt || "-"],
      [T("sum_last_to"), state.lastSendTo || "-"],
      [T("sum_last_error"), state.lastError || "-"]
    ];
  }

  function renderChart(host, days) {
    var max = 1;
    days.forEach(function (d) { if (d.total > max) max = d.total; });
    host.replaceChildren.apply(host, days.map(function (d) {
      var col = document.createElement("div");
      col.className = "chart-col";
      col.title = d.date + "：成功 " + d.ok + " / 失敗 " + d.fail;
      var okBar = document.createElement("div");
      okBar.className = "chart-bar ok";
      okBar.style.height = (d.total ? Math.max(3, Math.round((d.ok / max) * 100)) : 0) + "%";
      var failBar = document.createElement("div");
      failBar.className = "chart-bar fail";
      failBar.style.height = (d.total ? Math.max(0, Math.round((d.fail / max) * 100)) : 0) + "%";
      var stack = document.createElement("div");
      stack.className = "chart-stack";
      stack.append(failBar, okBar);
      var label = document.createElement("div");
      label.className = "chart-label";
      label.textContent = d.date.slice(5);
      col.append(stack, label);
      return col;
    }));
  }

  function renderPlatformBlock(p, data) {
    var wrap = document.createElement("div");
    wrap.className = "glass";
    wrap.style.marginTop = "14px";
    wrap.setAttribute("data-platform", p.platform);

    var h = document.createElement("h2");
    h.style.marginTop = "0";
    h.textContent = platformLabel(p.platform);
    wrap.appendChild(h);

    // 狀態摘要
    var sumHost = document.createElement("table");
    sumHost.className = "kv";
    var tb = document.createElement("tbody");
    var s = data.state;
    summaryRows(s, p.queue).forEach(function (pair) {
      var th = document.createElement("th");
      th.textContent = pair[0];
      tb.appendChild(tr(th, td(pair[1])));
    });
    sumHost.appendChild(tb);
    wrap.appendChild(sumHost);

    // 發送統計
    var stats = (data.statsByPlatform && data.statsByPlatform[p.platform]) || { total: 0, ok: 0, fail: 0, successRate: 0, byType: {}, days: [] };
    var cards = document.createElement("div");
    cards.className = "stat-cards";
    cards.style.marginTop = "12px";
    [[T("stat_total"), stats.total], [T("stat_ok"), stats.ok], [T("stat_fail"), stats.fail], [T("stat_rate"), stats.successRate + "%"]].forEach(function (c) {
      var card = document.createElement("div");
      card.className = "stat-card";
      var num = document.createElement("div");
      num.className = "stat-num";
      num.textContent = String(c[1]);
      var lbl = document.createElement("div");
      lbl.className = "stat-label";
      lbl.textContent = c[0];
      card.append(num, lbl);
      cards.appendChild(card);
    });
    wrap.appendChild(cards);

    var chart = document.createElement("div");
    chart.className = "chart";
    renderChart(chart, stats.days || []);
    wrap.appendChild(chart);

    var types = Object.keys(stats.byType || {}).map(function (k) { return k + "：" + stats.byType[k]; });
    var typeLine = document.createElement("div");
    typeLine.className = "msg";
    typeLine.style.marginTop = "10px";
    typeLine.textContent = types.length ? T("type_label") + " " + types.join("、") : T("no_send_records");
    wrap.appendChild(typeLine);

    return wrap;
  }

  function renderChips(platforms) {
    var host = $("platforms");
    // 只顯示目前選取平台的 chip。
    var shown = platforms.filter(function (p) { return p.platform === dashPlatform; });
    if (shown.length === 0) shown = platforms.filter(function (p) { return p.platform === "line"; });
    host.replaceChildren.apply(host, shown.map(function (p) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "active";
      b.textContent = platformLabel(p.platform) + "（目標 " + p.targets + "、佇列 " + p.queue.pending + (p.queue.running ? " 傳送中" : "") + "）";
      return b;
    }));
  }

  function render(data) {
    var s = data.state;
    var badge = $("badge");
    badge.textContent = s.status;
    badge.className = "badge " + (s.status === "已登入" ? "ok" : (s.status === "待驗證" || s.status === "需人工" ? "bad" : "warn"));

    var verify = $("verify");
    verify.replaceChildren();
    if (s.qrUrl) {
      qrBox.style.display = "block";
      if (s.qrUrl !== lastQr) { lastQr = s.qrUrl; qrImg.src = "/status/qr?t=" + Date.now(); }
      var a = document.createElement("a");
      a.href = s.qrUrl;
      a.textContent = "或點此在手機開啟驗證連結";
      a.target = "_blank";
      qrLink.replaceChildren(a);
    } else {
      qrBox.style.display = "none";
      lastQr = "";
    }
    if (s.pin) {
      var p = document.createElement("p");
      var b = document.createElement("b");
      b.textContent = "PIN 驗證碼：";
      var code = document.createElement("code");
      code.textContent = s.pin;
      p.append(b, code);
      verify.appendChild(p);
    }

    var platforms = data.platforms || [];
    renderChips(platforms);

    // 只顯示目前選取平台；若該平台不在線則回退到 LINE。
    var selected = platforms.filter(function (p) { return p.platform === dashPlatform; });
    if (selected.length === 0) selected = platforms.filter(function (p) { return p.platform === "line"; });
    var blocks = $("platform-blocks");
    blocks.replaceChildren.apply(blocks, selected.map(function (p) { return renderPlatformBlock(p, data); }));

    var logs = (data.logs || []).slice(-12).reverse();
    var logBody = $("logs");
    if (logs.length === 0) {
      logBody.replaceChildren(emptyRow(3));
    } else {
      logBody.replaceChildren.apply(logBody, logs.map(function (l) {
        return tr(td(l.time), td(l.level, "lv-" + l.level), td(l.message));
      }));
    }
  }

  window.onPlatformChange = function (platform) {
    dashPlatform = platform;
    refresh();
  };

  function refresh() {
    fetch("/dashboard.json?platform=" + encodeURIComponent(dashPlatform), { cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) { window.location.href = "/login"; return null; }
        return res.ok ? res.json() : null;
      })
      .then(function (data) { if (data) render(data); })
      .catch(function () {});
  }

  refresh();
  setInterval(refresh, 5000);
`;
    return page(tr(config.language, "title_dashboard"), "dashboard", body, script);
}
function renderSettingsHtml() {
    const deviceOptions = [
        "DESKTOPWIN",
        "DESKTOPMAC",
        "ANDROID",
        "ANDROIDSECONDARY",
        "IOS",
        "IOSIPAD",
        "WATCHOS",
        "WEAROS",
    ]
        .map((d) => `<option value="${d}">${d}</option>`)
        .join("");
    // 平台專屬設定以資料屬性標記；全域 IM 切換（右上角）改變時由 onPlatformChange 過濾。
    const platforms = [
        { id: "line", label: tr(config.language, "platform_line") },
        { id: "telegram", label: tr(config.language, "platform_telegram") },
    ];
    const body = `
<p class="msg" data-i18n="settings_note">設定儲存於 <code>settings.json</code>，修改後立即生效（LINE 裝置名稱需重新登入才生效）；點左側卡片切換設定項目。</p>

<form id="settings-form" class="fn-panel active">
  <fieldset class="fn-panel active" data-fn="security">
    <legend data-i18n="legend_security">安全 / 來源</legend>
    <div class="field"><label data-i18n="lbl_allowed_ips">允許的來源 IP</label><textarea id="allowedIps" data-i18n-ph="ph_allowed_ips" placeholder="逗號或換行分隔，留空 = 不限制"></textarea></div>
    <div class="auth-box">
    <div class="auth-box-title" data-i18n="lbl_hmac">HMAC 簽章密鑰</div>
    <div class="field"><label data-i18n="lbl_hmac">HMAC 簽章密鑰</label><span style="display:flex;gap:8px"><input id="hmacSecret" type="text" style="flex:1"><button type="button" id="hmac-generate" data-i18n="btn_generate">隨機產生</button></span><div class="hint" data-i18n="hint_hmac">留空 = 不驗證簽章</div></div>
    <div class="field"><label data-i18n="auth_enabled">啟用此驗證方式</label><input id="hmacEnabled" type="checkbox"><div class="hint" data-i18n="hint_auth_enabled">關閉後 HMAC 簽章不再被接受（建議只留一種驗證方式）</div></div>
    <div class="field"><label data-i18n="lbl_skew">時間戳記容許誤差（秒）</label><input id="hmacMaxSkewSec" type="number" min="0"></div>
    </div>
    <div class="auth-box">
    <div class="auth-box-title" data-i18n="lbl_webhook_token">Webhook URL Token</div>
    <div class="field"><label data-i18n="lbl_webhook_token">Webhook URL Token</label><span style="display:flex;gap:8px"><input id="webhookToken" type="text" style="flex:1"><button type="button" id="token-generate" data-i18n="btn_generate">隨機產生</button></span><div class="hint">供無法簽章的來源：網址帶 <code>?token=...</code> 或標頭 <code>X-Webhook-Token</code>；與 HMAC 並存時任一通過即可</div></div>
    <div class="field"><label data-i18n="auth_enabled">啟用此驗證方式</label><input id="webhookTokenEnabled" type="checkbox"><div class="hint" data-i18n="hint_auth_enabled">關閉後 URL Token 不再被接受（建議只留一種驗證方式）</div></div>
    </div>
    <div class="auth-box">
    <div class="auth-box-title" data-i18n="lbl_api_token">API Token（Bearer）</div>
    <div class="field"><label data-i18n="lbl_api_token">API Token（Bearer）</label><span style="display:flex;gap:8px"><input id="apiToken" type="text" style="flex:1"><button type="button" id="api-token-generate" data-i18n="btn_generate">隨機產生</button></span><div class="hint">主 Token（僅發送權限）。呼叫 webhook 時帶 <code>Authorization: Bearer &lt;token&gt;</code>；與 HMAC / URL Token 並存時任一通過即可</div></div>
    <div class="field"><label data-i18n="auth_enabled">啟用此驗證方式</label><input id="apiTokenEnabled" type="checkbox"><div class="hint" data-i18n="hint_auth_enabled">關閉後所有 Bearer Token（含多組）不再被接受（建議只留一種驗證方式）</div></div>
    <div class="field"><label data-i18n="lbl_api_tokens">多組 API Token</label><div id="apiTokens"></div><div class="hint" style="grid-column:1" data-i18n="token_hint_scopes">具名 token，可各自撤銷；與上方 API Token、HMAC、URL Token 任一通過即可</div></div>
    <div class="actions" style="margin:0 0 10px"><button type="button" id="api-token-add" data-i18n="btn_add_api_token">新增 API Token</button></div>
    </div>
    <div class="field"><label data-i18n="lbl_admin_private">僅限私人 IP 存取管理頁面</label><input id="adminPrivateOnly" type="checkbox"><div class="hint">狀態頁 / 儀表板 / 功能頁 / 設定頁 / 訊息 / ReadMe / 登入頁僅允許內網（10.x / 172.16–31.x / 192.168.x / 127.x）存取；webhook 不受影響</div></div>
    <div class="field"><label data-i18n="lbl_rate_window">速率限制視窗（ms）</label><input id="rateLimit-windowMs" type="number" min="1"></div>
    <div class="field"><label data-i18n="lbl_rate_max">每 IP 最大請求數</label><input id="rateLimit-max" type="number" min="1"></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="line" data-im="line">
    <legend data-i18n="legend_line">LINE 登入</legend>
    <div class="field"><label data-i18n="lbl_device">裝置類型</label><select id="line-device">${deviceOptions}</select></div>
    <div class="field"><label data-i18n="lbl_device_name">顯示名稱（systemName）</label><input id="line-deviceName" type="text"></div>
    <div class="field"><label data-i18n="lbl_model_name">機型（modelName）</label><input id="line-modelName" type="text"><div class="hint" data-i18n="hint_relogin_needed">顯示名稱需重新登入才生效</div></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="telegram" data-im="telegram">
    <legend data-i18n="legend_telegram">Telegram Bot</legend>
    <div class="field"><label data-i18n="lbl_tg_enabled">啟用 Telegram Bot</label><input id="tg-enabled" type="checkbox"><div class="hint">與 LINE 可同時上線；停用後 <code>/webhook/tg</code>、<code>/tg/update</code> 回 503</div></div>
    <div class="field"><label data-i18n="lbl_tg_bot_token">Bot Token</label><input id="tg-botToken" type="text" placeholder="123456:ABC-DEF..."><div class="hint" data-i18n="hint_tg_bot_token">向 @BotFather 申請；留空 = 停用 Telegram</div></div>
    <div class="field"><label data-i18n="lbl_tg_secret">Webhook Secret Token</label><span style="display:flex;gap:8px"><input id="tg-secretToken" type="text" style="flex:1"><button type="button" id="tg-secret-generate" data-i18n="btn_generate">隨機產生</button></span><div class="hint" data-i18n="hint_tg_secret">設定後 Telegram 會以此密鑰傳送 update（X-Telegram-Bot-Api-Secret-Token），建議設定</div></div>
    <div class="field"><label data-i18n="lbl_tg_webhook">Webhook URL</label><input id="tg-webhookUrl" type="text" placeholder="https://example.com/tg/update"><div class="hint" data-i18n="hint_tg_webhook">對外可存取的網址，結尾固定為 /tg/update；設定後重啟會自動註冊</div></div>
    <div class="field"><label data-i18n="lbl_tg_targets">目標對照（名稱=chat_id）</label><textarea id="tg-targets" placeholder="每行一筆，例如：我的群組=-1001234567890"></textarea><div class="hint" data-i18n="hint_tg_targets">每行一筆；也可填 @username</div></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="send">
    <legend data-i18n="legend_send">發送 / 重試</legend>
    <div class="field"><label data-i18n="lbl_max_retries">最大重試次數</label><input id="send-maxRetries" type="number" min="0"></div>
    <div class="field"><label data-i18n="lbl_retry_base">重試退避基準（ms）</label><input id="send-retryBaseMs" type="number" min="1"></div>
    <div class="field"><label data-i18n="lbl_min_interval">最小發送間隔（ms）</label><input id="send-minIntervalMs" type="number" min="0"></div>
    <div class="field"><label data-i18n="lbl_reply_max">回覆文字上限（字元）</label><input id="replyMaxChars" type="number" min="0"><div class="hint" data-i18n="hint_reply_max">超過會自動分段送出；0 = 不限制</div></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="monitor">
    <legend data-i18n="legend_monitor">監控 / Log</legend>
    <div class="field"><label data-i18n="lbl_timezone">時區</label><input id="timezone" type="text" placeholder="Asia/Taipei"><div class="hint" data-i18n="hint_timezone">IANA 時區名稱（例如 Asia/Taipei、UTC），影響 log 時間與技能（如「今天」的判斷）</div></div>
    <div class="field"><label data-i18n="lbl_health_interval">健康檢查間隔（秒）</label><input id="healthCheckIntervalSec" type="number" min="1"></div>
    <div class="field"><label data-i18n="lbl_log_limit">記憶體保留紀錄筆數</label><input id="logLimit" type="number" min="1"></div>
    <div class="field"><label data-i18n="lbl_log_max_bytes">Log 輪替大小（bytes）</label><input id="logMaxBytes" type="number" min="1"></div>
    <div class="field"><label data-i18n="lbl_log_max_files">Log 保留檔數</label><input id="logMaxFiles" type="number" min="1"></div>
    <div class="field"><label data-i18n="lbl_messages_persist">持久化收到的訊息</label><input id="messagesPersist" type="checkbox"><div class="hint">開啟後將收到的訊息寫入檔案（路徑：<code>${config.messagesPath}</code>，於 .env 設定）</div></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="targets-config" data-im="line">
    <legend data-i18n="legend_targets">目標對照（TARGETS）</legend>
    <div class="field"><label data-i18n="lbl_name_mid">名稱=mid</label><textarea id="targets" placeholder="每行一筆，例如：小明=u1234567890abcdef"></textarea></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="templates">
    <legend data-i18n="legend_templates">訊息模板（Templates）</legend>
    <div class="hint" style="margin-bottom:8px">webhook 帶 <code>template</code> 名稱與 <code>vars</code> 變數即可套用；模板內用 <code>{{key}}</code> 取用變數，未提供的變數會原樣保留。</div>
    <div id="templates"></div>
    <div class="actions"><button type="button" id="template-add" data-i18n="lbl_btn_add_template">新增模板</button></div>
    <div class="hint" style="margin:14px 0 8px">Flex 樣板：webhook 帶 <code>flexTemplate</code> 名稱即可套用；<code>contents</code> 為 Flex 容器 JSON（可用 <code>{{key}}</code> 變數）。</div>
    <div id="flexTemplates"></div>
    <div class="actions"><button type="button" id="flex-template-add" data-i18n="lbl_btn_add_flex">新增 Flex 樣板</button></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="forward">
    <legend data-i18n="legend_forward">訊息轉發規則</legend>
    <div class="hint" style="margin-bottom:8px">收到訊息且符合條件時，自動轉發到指定的好友 / 群組（填入名稱或 mid）。</div>
    <div id="forwardRules"></div>
    <div class="actions"><button type="button" id="forward-add" data-i18n="btn_add_forward">新增轉發規則</button></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="commands">
    <legend data-i18n="legend_commands">指令</legend>
    <div class="field"><label data-i18n="lbl_commands_enabled">啟用指令</label><input id="commands-enabled" type="checkbox"><div class="hint">允許在對話中對本帳號傳送指令（例如 <code>!help</code>）；LINE 與 Telegram 皆適用</div></div>
    <div class="field"><label data-i18n="lbl_commands_prefix">指令前綴</label><input id="commands-prefix" type="text" placeholder="!"><div class="hint">預設 <code>!</code></div></div>
    <div class="field"><label data-i18n="lbl_commands_allow">允許來源</label><textarea id="commands-allowFrom" data-i18n-ph="ph_commands_allow" placeholder="留空 = 所有人；每行一個 mid 或 chat mid"></textarea><div class="hint">可用 <code>!id</code> 取得自己的 mid / chat_id；建議限制來源避免被濫用</div></div>
    <div class="hint">可用指令：<code>help</code>、<code>status</code>、<code>id</code>、<code>send &lt;對象&gt; &lt;訊息&gt;</code></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="smtp">
    <legend data-i18n="legend_smtp">Email 通知（SMTP）</legend>
    <div class="field"><label>SMTP Host</label><input id="smtp-host" type="text"></div>
    <div class="field"><label>SMTP Port</label><input id="smtp-port" type="number" min="1"></div>
    <div class="field"><label>SMTP Secure</label><input id="smtp-secure" type="checkbox"></div>
    <div class="field"><label>SMTP User</label><input id="smtp-user" type="text"></div>
    <div class="field"><label>SMTP Password</label><input id="smtp-pass" type="password"></div>
    <div class="field"><label data-i18n="lbl_smtp_from">寄件者（From）</label><input id="smtp-from" type="text"></div>
    <div class="field"><label data-i18n="lbl_smtp_to">收件者（To）</label><input id="smtp-to" type="text"></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="backup">
    <legend data-i18n="legend_backup">設定匯出 / 匯入</legend>
    <div class="hint" style="margin-bottom:8px">匯出為 JSON 檔（含密鑰，請妥善保管）；匯入會覆蓋目前設定。</div>
    <div class="actions">
      <button type="button" id="settings-export" data-i18n="btn_export">匯出設定</button>
      <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer"><span data-i18n="btn_import">匯入設定</span><input id="settings-import-file" type="file" accept="application/json,.json" style="display:none"></label>
    </div>
  </fieldset>

  <div class="actions">
    <button type="submit" data-i18n="save_settings">儲存設定</button>
    <span id="settings-msg" class="msg"></span>
  </div>
</form>
`;
    const script = `
  ${HELPERS}
  ${SESSION_SCRIPT}
  var CONFIG_SECTIONS = ["security", "line", "telegram", "send", "monitor", "targets-config", "templates", "forward", "commands", "smtp", "backup"];

  function applySettingsPlatform(platform, jump) {
    Array.prototype.forEach.call(document.querySelectorAll("[data-im]"), function (el) {
      el.classList.toggle("plat-off", el.getAttribute("data-im") !== platform);
    });
    if (jump) showSection(platform, CONFIG_SECTIONS);
  }

  window.onPlatformChange = function (platform) {
    applySettingsPlatform(platform, true);
  };
  applySettingsPlatform(window.LW_PLATFORM || "line", false);

  function addForwardRow(rule) {
    rule = rule || {};
    var row = document.createElement("div");
    row.className = "forward-row";
    row.style.cssText = "border:1px solid rgba(244,114,182,.25);border-radius:12px;padding:10px 14px;margin-bottom:10px;background:rgba(0,0,0,.2)";

    function field(labelText, input) {
      var wrap = document.createElement("div");
      wrap.className = "field";
      var label = document.createElement("label");
      label.textContent = labelText;
      wrap.append(label, input);
      return wrap;
    }
    function textInput(cls, value, placeholder) {
      var input = document.createElement("input");
      input.className = cls;
      input.type = "text";
      input.value = value || "";
      if (placeholder) input.placeholder = placeholder;
      return input;
    }

    var match = document.createElement("select");
    match.className = "f-match";
    [["contains", "match_contains"], ["regex", "match_regex"], ["all", "match_all"]].forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt[0];
      o.textContent = T(opt[1]);
      if ((rule.match || "contains") === opt[0]) o.selected = true;
      match.appendChild(o);
    });
    var keyword = textInput("f-keyword", rule.keyword, T("lbl_keyword"));
    var source = textInput("f-source", rule.source, T("lbl_source"));
    var target = textInput("f-target", rule.target, T("lbl_forward_target"));
    var prefix = textInput("f-prefix", rule.prefix, T("lbl_prefix"));
    var includeSender = document.createElement("input");
    includeSender.type = "checkbox";
    includeSender.className = "f-includeSender";
    includeSender.checked = !!rule.includeSender;
    var enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "f-enabled";
    enabled.checked = rule.enabled !== false;

    row.append(field(T("lbl_match_type"), match));
    row.append(field(T("lbl_keyword"), keyword));
    row.append(field(T("lbl_source"), source));
    row.append(field(T("lbl_forward_target"), target));
    row.append(field(T("lbl_prefix"), prefix));
    row.append(field(T("lbl_include_sender"), includeSender));
    row.append(field(T("lbl_enabled"), enabled));

    var actions = document.createElement("div");
    actions.className = "actions";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = T("btn_delete_rule");
    remove.addEventListener("click", function () { row.remove(); });
    actions.appendChild(remove);
    row.appendChild(actions);

    $("forwardRules").appendChild(row);
  }

  function collectForwardRules() {
    var out = [];
    var rows = $("forwardRules").querySelectorAll(".forward-row");
    Array.prototype.forEach.call(rows, function (row) {
      out.push({
        id: row.getAttribute("data-id") || "",
        enabled: row.querySelector(".f-enabled").checked,
        match: row.querySelector(".f-match").value,
        keyword: row.querySelector(".f-keyword").value,
        source: row.querySelector(".f-source").value.trim(),
        target: row.querySelector(".f-target").value.trim(),
        includeSender: row.querySelector(".f-includeSender").checked,
        prefix: row.querySelector(".f-prefix").value
      });
    });
    return out;
  }

  function addApiTokenRow(item) {
    item = item || {};
    var scopes = Array.isArray(item.scopes) ? item.scopes : ["send"];
    var row = document.createElement("div");
    row.className = "api-token-row";
    row.style.cssText = "display:flex;gap:8px;margin-bottom:8px;grid-column:2;flex-wrap:wrap;align-items:center";
    var name = document.createElement("input");
    name.type = "text";
    name.className = "at-name";
    name.value = item.name || "";
    name.placeholder = T("lbl_name");
    name.style.flex = "0 0 120px";
    var token = document.createElement("input");
    token.type = "text";
    token.className = "at-token";
    token.value = item.token || "";
    token.placeholder = "token";
    token.style.flex = "1";
    var gen = document.createElement("button");
    gen.type = "button";
    gen.textContent = T("btn_generate");
    gen.addEventListener("click", function () { token.value = randomHex(32); });
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = T("btn_delete");
    remove.addEventListener("click", function () { row.remove(); });
    row.append(name, token, gen, remove);
    var scopeWrap = document.createElement("span");
    scopeWrap.style.cssText = "display:flex;gap:10px;align-items:center;flex:1 1 100%;font-size:13px;color:#94a3b8";
    var scopeLabel = document.createElement("span");
    scopeLabel.textContent = T("lbl_scope") + "：";
    scopeWrap.appendChild(scopeLabel);
    ["read", "send", "admin"].forEach(function (s) {
      var label = document.createElement("label");
      label.style.cssText = "display:flex;gap:4px;align-items:center;cursor:pointer";
      var box = document.createElement("input");
      box.type = "checkbox";
      box.className = "at-scope";
      box.value = s;
      box.checked = scopes.indexOf(s) !== -1;
      label.append(box, document.createTextNode(T("scope_" + s)));
      scopeWrap.appendChild(label);
    });
    var usage = document.createElement("span");
    usage.className = "at-usage msg";
    usage.style.marginLeft = "auto";
    scopeWrap.appendChild(usage);
    row.appendChild(scopeWrap);
    $("apiTokens").appendChild(row);
  }

  function collectApiTokens() {
    var out = [];
    var rows = $("apiTokens").querySelectorAll(".api-token-row");
    Array.prototype.forEach.call(rows, function (row) {
      var scopes = [];
      Array.prototype.forEach.call(row.querySelectorAll(".at-scope:checked"), function (box) {
        scopes.push(box.value);
      });
      out.push({
        name: row.querySelector(".at-name").value.trim(),
        token: row.querySelector(".at-token").value.trim(),
        scopes: scopes
      });
    });
    return out.filter(function (item) { return item.token; });
  }

  function refreshTokenUsage() {
    fetch("/tokens/usage.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        var byName = {};
        ((data && data.usage) || []).forEach(function (u) { byName[u.name] = u; });
        Array.prototype.forEach.call($("apiTokens").querySelectorAll(".api-token-row"), function (row) {
          var el = row.querySelector(".at-usage");
          if (!el) return;
          var u = byName[row.querySelector(".at-name").value.trim()];
          if (!u || !u.count) { el.textContent = T("token_never_used"); return; }
          var last = u.lastUsedAt ? u.lastUsedAt.slice(0, 16).replace("T", " ") : "";
          el.textContent = T("token_used") + " " + u.count + T("token_times") + (last ? " · " + T("token_last") + " " + last : "");
        });
      })
      .catch(function () {});
  }

  function addTemplateRow(tpl) {
    tpl = tpl || {};
    var row = document.createElement("div");
    row.className = "template-row";
    row.style.cssText = "border:1px solid rgba(34,211,238,.25);border-radius:12px;padding:10px 14px;margin-bottom:10px;background:rgba(0,0,0,.2)";

    function field(labelText, input) {
      var wrap = document.createElement("div");
      wrap.className = "field";
      var label = document.createElement("label");
      label.textContent = labelText;
      wrap.append(label, input);
      return wrap;
    }

    var name = document.createElement("input");
    name.type = "text";
    name.className = "t-name";
    name.value = tpl.name || "";
    name.placeholder = T("lbl_name");

    var text = document.createElement("textarea");
    text.className = "t-text";
    text.value = tpl.text || "";
    text.placeholder = T("lbl_content");

    row.append(field(T("lbl_name"), name));
    row.append(field(T("lbl_content"), text));

    var actions = document.createElement("div");
    actions.className = "actions";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = T("btn_delete_template");
    remove.addEventListener("click", function () { row.remove(); });
    actions.appendChild(remove);
    row.appendChild(actions);

    $("templates").appendChild(row);
  }

  function collectTemplates() {
    var out = [];
    var rows = $("templates").querySelectorAll(".template-row");
    Array.prototype.forEach.call(rows, function (row) {
      out.push({
        name: row.querySelector(".t-name").value.trim(),
        text: row.querySelector(".t-text").value
      });
    });
    return out;
  }

  function addFlexTemplateRow(tpl) {
    tpl = tpl || {};
    var row = document.createElement("div");
    row.className = "flex-template-row";
    row.style.cssText = "border:1px solid rgba(244,114,182,.25);border-radius:12px;padding:10px 14px;margin-bottom:10px;background:rgba(0,0,0,.2)";

    function field(labelText, input) {
      var wrap = document.createElement("div");
      wrap.className = "field";
      var label = document.createElement("label");
      label.textContent = labelText;
      wrap.append(label, input);
      return wrap;
    }

    var name = document.createElement("input");
    name.type = "text";
    name.className = "ft-name";
    name.value = tpl.name || "";
    name.placeholder = T("lbl_name");

    var alt = document.createElement("input");
    alt.type = "text";
    alt.className = "ft-alt";
    alt.value = tpl.altText || "";
    alt.placeholder = T("lbl_alt_text");

    var contents = document.createElement("textarea");
    contents.className = "ft-contents";
    contents.value = tpl.contents || "";
    contents.placeholder = '{"type":"bubble","body":{...}}';

    row.append(field(T("lbl_name"), name));
    row.append(field(T("lbl_alt_text"), alt));
    row.append(field(T("lbl_flex_json"), contents));

    var actions = document.createElement("div");
    actions.className = "actions";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = T("btn_delete_flex");
    remove.addEventListener("click", function () { row.remove(); });
    actions.appendChild(remove);
    row.appendChild(actions);

    $("flexTemplates").appendChild(row);
  }

  function collectFlexTemplates() {
    var out = [];
    var rows = $("flexTemplates").querySelectorAll(".flex-template-row");
    Array.prototype.forEach.call(rows, function (row) {
      out.push({
        name: row.querySelector(".ft-name").value.trim(),
        altText: row.querySelector(".ft-alt").value,
        contents: row.querySelector(".ft-contents").value
      });
    });
    return out;
  }

  function fillForm(s) {
    $("allowedIps").value = (s.allowedIps || []).join(", ");
    $("hmacSecret").value = s.hmacSecret || "";
    $("hmacEnabled").checked = s.hmacEnabled !== false;
    $("hmacMaxSkewSec").value = s.hmacMaxSkewSec;
    $("webhookToken").value = s.webhookToken || "";
    $("webhookTokenEnabled").checked = s.webhookTokenEnabled !== false;
    $("apiToken").value = s.apiToken || "";
    $("apiTokenEnabled").checked = s.apiTokenEnabled !== false;
    $("adminPrivateOnly").checked = !!s.adminPrivateOnly;
    $("rateLimit-windowMs").value = s.rateLimit.windowMs;
    $("rateLimit-max").value = s.rateLimit.max;
    $("line-device").value = s.line.device;
    $("line-deviceName").value = s.line.deviceName || "";
    $("line-modelName").value = s.line.modelName || "";
    $("tg-enabled").checked = !!(s.telegram && s.telegram.enabled);
    $("tg-botToken").value = (s.telegram && s.telegram.botToken) || "";
    $("tg-secretToken").value = (s.telegram && s.telegram.secretToken) || "";
    $("tg-webhookUrl").value = (s.telegram && s.telegram.webhookUrl) || "";
    $("tg-targets").value = Object.keys((s.telegram && s.telegram.targets) || {}).map(function (k) { return k + "=" + s.telegram.targets[k]; }).join("\\n");
    $("send-maxRetries").value = s.send.maxRetries;
    $("send-retryBaseMs").value = s.send.retryBaseMs;
    $("send-minIntervalMs").value = s.send.minIntervalMs;
    $("replyMaxChars").value = s.replyMaxChars;
    $("healthCheckIntervalSec").value = s.healthCheckIntervalSec;
    $("logLimit").value = s.logLimit;
    $("logMaxBytes").value = s.logMaxBytes;
    $("logMaxFiles").value = s.logMaxFiles;
    $("messagesPersist").checked = !!s.messagesPersist;
    $("timezone").value = s.timezone || "Asia/Taipei";
    $("targets").value = Object.keys(s.targets || {}).map(function (k) { return k + "=" + s.targets[k]; }).join("\\n");
    $("smtp-host").value = s.smtp.host || "";
    $("smtp-port").value = s.smtp.port;
    $("smtp-secure").checked = !!s.smtp.secure;
    $("smtp-user").value = s.smtp.user || "";
    $("smtp-pass").value = s.smtp.pass || "";
    $("smtp-from").value = s.smtp.from || "";
    $("smtp-to").value = s.smtp.to || "";
    $("templates").replaceChildren();
    (s.templates || []).forEach(addTemplateRow);
    $("flexTemplates").replaceChildren();
    (s.flexTemplates || []).forEach(addFlexTemplateRow);
    $("apiTokens").replaceChildren();
    (s.apiTokens || []).forEach(addApiTokenRow);
    refreshTokenUsage();
    $("forwardRules").replaceChildren();
    (s.forward || []).forEach(addForwardRow);
    $("commands-enabled").checked = !!(s.commands && s.commands.enabled);
    $("commands-prefix").value = (s.commands && s.commands.prefix) || "!";
    $("commands-allowFrom").value = ((s.commands && s.commands.allowFrom) || []).join("\\n");
  }

  function loadForm() {
    fetch("/settings.json", { cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) { window.location.href = "/login"; return null; }
        return res.ok ? res.json() : null;
      })
      .then(function (s) { if (s) fillForm(s); })
      .catch(function () {});
  }

  function collectForm() {
    var targets = {};
    $("targets").value.split(/\\r?\\n/).forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      var i = t.indexOf("=");
      if (i <= 0) return;
      targets[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    });
    var tgTargets = {};
    $("tg-targets").value.split(/\\r?\\n/).forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      var i = t.indexOf("=");
      if (i <= 0) return;
      tgTargets[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    });
    return {
      allowedIps: $("allowedIps").value.split(/[\\n,]/).map(function (x) { return x.trim(); }).filter(Boolean),
      hmacSecret: $("hmacSecret").value,
      hmacEnabled: $("hmacEnabled").checked,
      hmacMaxSkewSec: Number($("hmacMaxSkewSec").value),
      webhookToken: $("webhookToken").value,
      webhookTokenEnabled: $("webhookTokenEnabled").checked,
      apiToken: $("apiToken").value,
      apiTokenEnabled: $("apiTokenEnabled").checked,
      apiTokens: collectApiTokens(),
      adminPrivateOnly: $("adminPrivateOnly").checked,
      targets: targets,
      templates: collectTemplates(),
      flexTemplates: collectFlexTemplates(),
      forward: collectForwardRules(),
      healthCheckIntervalSec: Number($("healthCheckIntervalSec").value),
      logLimit: Number($("logLimit").value),
      logMaxBytes: Number($("logMaxBytes").value),
      logMaxFiles: Number($("logMaxFiles").value),
      messagesPersist: $("messagesPersist").checked,
      timezone: $("timezone").value.trim() || "Asia/Taipei",
      send: {
        maxRetries: Number($("send-maxRetries").value),
        retryBaseMs: Number($("send-retryBaseMs").value),
        minIntervalMs: Number($("send-minIntervalMs").value)
      },
      rateLimit: {
        windowMs: Number($("rateLimit-windowMs").value),
        max: Number($("rateLimit-max").value)
      },
      replyMaxChars: Number($("replyMaxChars").value),
      line: {
        device: $("line-device").value,
        deviceName: $("line-deviceName").value,
        modelName: $("line-modelName").value
      },
      telegram: {
        enabled: $("tg-enabled").checked,
        botToken: $("tg-botToken").value.trim(),
        secretToken: $("tg-secretToken").value.trim(),
        webhookUrl: $("tg-webhookUrl").value.trim(),
        targets: tgTargets
      },
      smtp: {
        host: $("smtp-host").value,
        port: Number($("smtp-port").value),
        secure: $("smtp-secure").checked,
        user: $("smtp-user").value,
        pass: $("smtp-pass").value,
        from: $("smtp-from").value,
        to: $("smtp-to").value
      },
      commands: {
        enabled: $("commands-enabled").checked,
        prefix: $("commands-prefix").value || "!",
        allowFrom: $("commands-allowFrom").value.split(/[\\n,]/).map(function (x) { return x.trim(); }).filter(Boolean)
      }
    };
  }

  function randomHex(bytes) {
    var buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return Array.prototype.map.call(buf, function (b) {
      return ("0" + b.toString(16)).slice(-2);
    }).join("");
  }

  $("hmac-generate").addEventListener("click", function () {
    $("hmacSecret").value = randomHex(32);
    $("settings-msg").textContent = "已產生新密鑰，請按「儲存設定」";
  });

  $("token-generate").addEventListener("click", function () {
    $("webhookToken").value = randomHex(32);
    $("settings-msg").textContent = "已產生新 token，請按「儲存設定」";
  });

  $("api-token-generate").addEventListener("click", function () {
    $("apiToken").value = randomHex(32);
    $("settings-msg").textContent = "已產生新 API Token，請按「儲存設定」";
  });

  $("tg-secret-generate").addEventListener("click", function () {
    $("tg-secretToken").value = randomHex(32);
    $("settings-msg").textContent = "已產生新 Telegram Secret Token，儲存並重啟後生效（會重新 setWebhook）";
  });

  $("template-add").addEventListener("click", function () {
    addTemplateRow({});
  });

  $("flex-template-add").addEventListener("click", function () {
    addFlexTemplateRow({});
  });

  $("api-token-add").addEventListener("click", function () {
    addApiTokenRow({});
  });

  $("forward-add").addEventListener("click", function () {
    addForwardRow({});
  });

  $("settings-export").addEventListener("click", function () {
    window.location.href = "/settings/export";
  });

  $("settings-import-file").addEventListener("change", function () {
    var input = $("settings-import-file");
    if (!input.files || !input.files[0]) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(String(reader.result)); }
      catch (e) { $("settings-msg").textContent = "匯入失敗：JSON 格式錯誤"; return; }
      post("settings/import", { settings: parsed }).then(function (r) {
        if (!r.ok) { $("settings-msg").textContent = "匯入失敗：" + (r.data.error || ""); return; }
        $("settings-msg").textContent = "已匯入設定";
        fillForm(r.data.settings);
      });
    };
    reader.readAsText(input.files[0]);
    input.value = "";
  });

  $("settings-form").addEventListener("submit", function (e) {
    e.preventDefault();
    $("settings-msg").textContent = "儲存中…";
    post("settings", collectForm()).then(function (r) {
      $("settings-msg").textContent = r.ok ? "已儲存" : ("失敗：" + (r.data.error || ""));
    });
  });

  setupCards(CONFIG_SECTIONS, "security");
  loadForm();
`;
    const sidebar = `
<div class="side-section">${tr(config.language, "section_settings")}</div>
<div class="fn-list">
  <button type="button" class="fn-card setting active" data-fn="security">${tr(config.language, "card_security")}</button>
  <button type="button" class="fn-card setting" data-fn="line" data-im="line">${tr(config.language, "card_line")}</button>
  <button type="button" class="fn-card setting" data-fn="telegram" data-im="telegram">${tr(config.language, "card_telegram")}</button>
  <button type="button" class="fn-card setting" data-fn="send">${tr(config.language, "card_send")}</button>
  <button type="button" class="fn-card setting" data-fn="monitor">${tr(config.language, "card_monitor")}</button>
  <button type="button" class="fn-card setting" data-fn="targets-config" data-im="line">${tr(config.language, "card_targets_config")}</button>
  <button type="button" class="fn-card setting" data-fn="templates">${tr(config.language, "card_templates")}</button>
  <button type="button" class="fn-card setting" data-fn="forward">${tr(config.language, "card_forward")}</button>
  <button type="button" class="fn-card setting" data-fn="commands">${tr(config.language, "card_commands")}</button>
  <button type="button" class="fn-card setting" data-fn="smtp">${tr(config.language, "card_smtp")}</button>
  <button type="button" class="fn-card setting" data-fn="backup">${tr(config.language, "card_backup")}</button>
</div>`;
    return page(tr(config.language, "title_settings"), "settings", body, script, { sidebar });
}
function renderConsoleHtml() {
    const body = `
<div class="fn-panel active" data-fn="test">
<h2 style="margin-top:0" data-i18n="panel_test">測試發送</h2>
<div class="glass glass-hover">
<form id="test-form">
  <div class="field"><label data-i18n="lbl_to">對象</label><input id="test-to" placeholder="好友名稱或 mid" required><div class="hint">發送平台由左側「通訊平台」決定</div></div>
  <div class="field"><label data-i18n="lbl_text">文字</label><input id="test-text" placeholder="訊息內容（可留空）"></div>
  <div class="field"><label data-i18n="lbl_file_path">檔案路徑</label><input id="test-file" placeholder="伺服器上的檔案路徑，例如 /opt/app/quote.pdf"></div>
  <div class="field"><label data-i18n="lbl_image">圖片（URL 或路徑）</label><input id="test-image" placeholder="https://... 或 /opt/app/a.jpg"></div>
  <div class="field"><label data-i18n="lbl_video">影片（URL 或路徑）</label><input id="test-video" placeholder="https://... 或 /opt/app/a.mp4"></div>
  <div class="field"><label data-i18n="lbl_audio">語音（URL 或路徑）</label><input id="test-audio" placeholder="https://... 或 /opt/app/a.m4a"></div>
  <div class="field"><label data-i18n="lbl_display_filename">顯示檔名</label><input id="test-filename" placeholder="選填"></div>
  <details>
    <summary data-i18n="summary_advanced">進階（貼圖 / 位置 / Flex / 延遲）</summary>
    <div class="field"><label data-i18n="lbl_sticker_pkg">貼圖 packageId</label><input id="test-sticker-pkg" placeholder="例如 446"></div>
    <div class="field"><label data-i18n="lbl_sticker_id">貼圖 stickerId</label><input id="test-sticker-id" placeholder="例如 1988"></div>
    <div class="field"><label data-i18n="lbl_loc_title">位置標題</label><input id="test-loc-title" placeholder="選填"></div>
    <div class="field"><label data-i18n="lbl_loc_address">位置地址</label><input id="test-loc-address" placeholder="選填"></div>
    <div class="field"><label data-i18n="lbl_lat_lng">緯度 / 經度</label><span style="display:flex;gap:8px"><input id="test-loc-lat" placeholder="25.033" style="flex:1"><input id="test-loc-lng" placeholder="121.565" style="flex:1"></span></div>
    <div class="field"><label data-i18n="lbl_flex_alt">Flex altText</label><input id="test-flex-alt" placeholder="選填"></div>
    <div class="field"><label data-i18n="lbl_flex_json">Flex JSON</label><textarea id="test-flex-json" placeholder='{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"Hi"}]}}'></textarea></div>
    <div class="field"><label data-i18n="lbl_delay">延遲發送</label><span style="display:flex;gap:8px;align-items:center"><input id="test-delay" type="text" placeholder="秒數（例如 60）或 2026-01-01 09:00:00" style="flex:1;min-width:200px"><input id="test-datetime" type="datetime-local" style="position:absolute;opacity:0;pointer-events:none;width:0;height:0"><button type="button" id="test-datetime-btn" class="icon-btn" title="選擇日期時間">&#128197;</button></span><div class="hint">可填「秒數」或「年月日 時:分:秒」；點日曆圖示選時間會帶入欄位。留空 = 立即發送</div></div>
  </details>
  <div class="field"><label>插入媒體</label><span style="display:flex;gap:8px;flex-wrap:wrap"><input id="test-upload" type="file" style="flex:1"><button type="button" id="test-upload-btn">上傳並填入</button><span id="test-upload-msg" class="msg"></span></span></div>
   <div class="actions"><button type="submit" data-i18n="btn_send">發送</button><span id="test-msg" class="msg"></span></div>
</form>
</div>
</div>

<div class="fn-panel" data-fn="flex-editor">
<h2 style="margin-top:0" data-i18n="panel_flex_editor">Flex 可視化編輯</h2>
<div class="glass">
<div style="display:flex;gap:16px;flex-wrap:wrap">
<div style="flex:1;min-width:260px">
<form id="flex-editor-form">
  <div class="field"><label data-i18n="lbl_flex_alt">Flex altText</label><input id="fx-alt" placeholder="Flex 訊息"></div>
  <div class="field"><label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input id="fx-hero-on" type="checkbox" checked style="width:auto"><span data-i18n="fx_show_hero">顯示主圖</span></label></div>
  <div class="field"><label data-i18n="fx_hero_url">主圖 URL</label><input id="fx-hero-url" placeholder="https://..."></div>
  <div class="field"><label data-i18n="fx_hero_ratio">主圖比例</label><select id="fx-hero-ratio"><option value="20:13">20:13</option><option value="1:1">1:1</option><option value="4:3">4:3</option><option value="16:9">16:9</option></select></div>
  <div class="field"><label data-i18n="fx_title">標題</label><input id="fx-title" placeholder="標題文字"></div>
  <div class="field"><label data-i18n="fx_body">內文</label><textarea id="fx-body" placeholder="內文（換行會保留）"></textarea></div>
  <div class="field"><label data-i18n="fx_buttons">按鈕（最多 3 個）</label><div id="fx-buttons"></div><div class="actions"><button type="button" id="fx-btn-add" data-i18n="fx_btn_add">新增按鈕</button></div></div>
  <div class="actions"><button type="button" id="fx-fill-test" data-i18n="fx_fill_test">填入測試表單</button><button type="button" id="fx-copy" data-i18n="fx_copy">複製 JSON</button><span id="fx-msg" class="msg"></span></div>
</form>
</div>
<div style="flex:1;min-width:260px">
  <div class="field"><label data-i18n="fx_preview">預覽（示意）</label><div id="fx-preview" style="max-width:320px;margin:0 auto"></div></div>
  <div class="field"><label data-i18n="fx_json_out">產生的 Flex JSON</label><textarea id="fx-json" readonly style="min-height:140px"></textarea></div>
</div>
</div>
</div>
</div>

<div class="fn-panel" data-fn="targets-list">
<h2 style="margin-top:0" data-i18n="panel_targets">目標清單</h2>
<div class="glass">
<details id="targets-details" open>
  <summary><span data-i18n="list_count">清單</span>（<span id="target-count">0</span>）</summary>
  <div style="margin:8px 0">
    <input id="target-search" data-i18n-ph="ph_search" placeholder="搜尋名稱或 MID" style="width:280px">
    <span id="target-msg" class="msg"></span>
  </div>
  <table class="targets-table"><thead><tr><th data-i18n="th_name">名稱</th><th>MID</th><th class="th-actions" style="width:180px" data-i18n="th_actions">操作</th></tr></thead><tbody id="targets"></tbody></table>
</details>
</div>
</div>

<div class="fn-panel" data-fn="logs">
<h2 style="margin-top:0" data-i18n="panel_logs">最近紀錄</h2>
<div class="glass">
<details open>
  <summary data-i18n="list_count">清單</summary>
  <table><thead><tr><th data-i18n="th_time">時間</th><th data-i18n="th_level">等級</th><th data-i18n="th_message">訊息</th><th data-i18n="th_content">內容</th></tr></thead><tbody id="logs"></tbody></table>
</details>
</div>
</div>

<div class="fn-panel" data-fn="scheduled">
<h2 style="margin-top:0" data-i18n="panel_scheduled">排程中的訊息</h2>
<div class="glass">
<details open>
  <summary><span data-i18n="list_count">清單</span>（<span id="scheduled-count">0</span>）</summary>
  <table><thead><tr><th data-i18n="th_time">時間</th><th data-i18n="th_target">對象</th><th data-i18n="th_content">內容</th><th data-i18n="th_repeat">重複</th><th style="width:190px" data-i18n="th_actions">操作</th></tr></thead><tbody id="scheduled"></tbody></table>
</details>
</div>
</div>
`;
    const script = `
  ${HELPERS}
  ${SESSION_SCRIPT}
  var allTargets = [];
  var currentPlatform = window.LW_PLATFORM || "line";

  window.onPlatformChange = function (platform) {
    currentPlatform = platform;
    refreshData();
  };

  function renderTargets() {
    var query = $("target-search").value.trim().toLowerCase();
    var list = allTargets.filter(function (t) {
      if (!query) return true;
      return t.name.toLowerCase().indexOf(query) !== -1 || t.id.toLowerCase().indexOf(query) !== -1;
    });
    var body = $("targets");
    if (list.length === 0) {
      body.replaceChildren(emptyRow(3));
      return;
    }
    body.replaceChildren.apply(body, list.map(function (t) {
      var copyBtn = document.createElement("button");
      copyBtn.textContent = T("btn_copy_mapping");
      copyBtn.addEventListener("click", function () {
        var text = t.name + "=" + t.id;
        copyText(text).then(function (ok) {
          $("target-msg").textContent = ok ? "已複製：" + t.name : "無法自動複製，請手動選取：" + text;
        });
      });
      var testBtn = document.createElement("button");
      testBtn.textContent = T("btn_test");
      testBtn.addEventListener("click", function () {
        $("test-to").value = t.name;
        $("test-to").focus();
        $("target-msg").textContent = "已帶入測試對象：" + t.name;
      });
      var actions = document.createElement("td");
      actions.className = "actions-cell";
      actions.append(copyBtn, testBtn);
      return tr(td(t.name), td(t.id, "mono"), actions);
    }));
  }

  function renderScheduled(jobs) {
    jobs = jobs || [];
    $("scheduled-count").textContent = String(jobs.length);
    var body = $("scheduled");
    if (jobs.length === 0) {
      body.replaceChildren(emptyRow(5));
      return;
    }
    body.replaceChildren.apply(body, jobs.map(function (j) {
      var cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = T("btn_cancel");
      cancel.addEventListener("click", function () {
        post("settings/scheduled/cancel", { id: j.id }).then(function () { refreshData(); });
      });
      var edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = T("btn_edit_time");
      edit.addEventListener("click", function () {
        var input = window.prompt("幾秒後發送，或輸入時間（例：2026-01-01 09:00:00）", "60");
        if (input === null) return;
        var value = input.trim();
        if (!value) return;
        var body = { id: j.id };
        if (/^\d+$/.test(value)) body.delaySec = Number(value);
        else body.sendAt = value;
        post("settings/scheduled/update", body).then(function (r) {
          if (!r.ok) alert("失敗：" + (r.data.error || ""));
          refreshData();
        });
      });
      var actions = document.createElement("td");
      actions.className = "actions-cell";
      actions.append(edit, cancel);
      return tr(td(j.runAt), td((j.to || []).join(", ")), td(j.summary || ""), td(j.repeat || "-"), actions);
    }));
  }

  function renderData(data) {
    $("target-count").textContent = String(data.targets.length);
    allTargets = data.targets;
    renderTargets();
    renderScheduled(data.scheduled);

    var logs = data.logs.slice().reverse();
    var logBody = $("logs");
    if (logs.length === 0) {
      logBody.replaceChildren(emptyRow(4));
    } else {
      logBody.replaceChildren.apply(logBody, logs.map(function (l) {
        return tr(td(l.time), td(l.level, "lv-" + l.level), td(l.message), td(l.meta ? JSON.stringify(l.meta) : "", "mono"));
      }));
    }
  }

  function refreshData() {
    fetch("/status.json?platform=" + encodeURIComponent(currentPlatform), { cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) { window.location.href = "/login"; return null; }
        return res.ok ? res.json() : null;
      })
      .then(function (data) { if (data) renderData(data); })
      .catch(function () {});
  }

  $("target-search").addEventListener("input", renderTargets);

  $("btn-relogin").addEventListener("click", function () {
    $("action-msg").textContent = "重登中…";
    post("settings/relogin").then(function (r) {
      $("action-msg").textContent = r.ok ? "已觸發重新登入" : ("失敗：" + (r.data.error || ""));
    });
  });

  $("btn-refresh").addEventListener("click", function () {
    $("action-msg").textContent = "更新中…";
    post("settings/refresh").then(function (r) {
      $("action-msg").textContent = r.ok ? "聯絡人已更新" : ("失敗：" + (r.data.error || ""));
      refreshData();
    });
  });

  $("test-upload-btn").addEventListener("click", function () {
    var input = $("test-upload");
    if (!input.files || !input.files[0]) { $("test-upload-msg").textContent = "請先選擇檔案"; return; }
    var file = input.files[0];
    $("test-upload-msg").textContent = "上傳中…";
    file.arrayBuffer().then(function (buf) {
      return fetch("/settings/upload", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
        body: buf
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (r) {
      if (!r.ok) { $("test-upload-msg").textContent = "失敗：" + (r.data.error || ""); return; }
      $("test-image").value = r.data.path;
      $("test-filename").value = r.data.filename;
      $("test-upload-msg").textContent = "已上傳（" + r.data.bytes + " bytes）並填入圖片欄位";
    }).catch(function () { $("test-upload-msg").textContent = "上傳失敗"; });
  });

  function pad2(n) { return ("0" + n).slice(-2); }

  function toLocalInput(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate())
      + "T" + pad2(date.getHours()) + ":" + pad2(date.getMinutes());
  }

  function setDelayFromPicker() {
    var v = $("test-datetime").value;
    if (!v) return;
    var d = new Date(v);
    if (isNaN(d.getTime())) return;
    $("test-delay").value = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
      + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  $("test-datetime").addEventListener("change", setDelayFromPicker);
  $("test-datetime-btn").addEventListener("click", function () {
    var input = $("test-datetime");
    if (!input.value) {
      var d = new Date(Date.now() + 60000);
      d.setSeconds(0, 0);
      input.value = toLocalInput(d);
    }
    if (typeof input.showPicker === "function") {
      try { input.showPicker(); return; } catch (e) { /* fall through */ }
    }
    input.style.position = "static";
    input.style.opacity = "1";
    input.style.pointerEvents = "auto";
    input.style.width = "auto";
    input.style.height = "auto";
    input.focus();
    input.click();
  });

  $("test-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var payload = {
      to: $("test-to").value.trim(),
      platform: currentPlatform,
      text: $("test-text").value,
      file: $("test-file").value.trim(),
      image: $("test-image").value.trim(),
      video: $("test-video").value.trim(),
      audio: $("test-audio").value.trim(),
      filename: $("test-filename").value.trim()
    };
    var pkg = $("test-sticker-pkg").value.trim();
    var sid = $("test-sticker-id").value.trim();
    if (pkg && sid) payload.sticker = { packageId: pkg, stickerId: sid };
    var lat = $("test-loc-lat").value.trim();
    var lng = $("test-loc-lng").value.trim();
    if (lat && lng) {
      payload.location = {
        title: $("test-loc-title").value,
        address: $("test-loc-address").value,
        latitude: Number(lat),
        longitude: Number(lng)
      };
    }
    var flexJson = $("test-flex-json").value.trim();
    if (flexJson) {
      payload.flex = {
        altText: $("test-flex-alt").value.trim() || "Flex 訊息",
        contents: flexJson
      };
    }
    var delay = $("test-delay").value.trim();
    if (delay) {
      if (/^\d+$/.test(delay)) {
        payload.delaySec = Number(delay);
      } else {
        payload.sendAt = delay;
      }
    }

    $("test-msg").textContent = "處理中…";
    post("settings/test", payload).then(function (r) {
      if (!r.ok) {
        $("test-msg").textContent = "失敗：" + (r.data.error || "");
        return;
      }
      $("test-msg").textContent = r.data.scheduled ? ("已排程：" + r.data.runAt) : "已送出";
      refreshData();
    });
  });

  /* ---- Flex 可視化編輯器 ---- */
  var FX_DRAFT_KEY = "linehook-flex-draft";

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function addFxButtonRow(btn) {
    btn = btn || {};
    var rows = $("fx-buttons").querySelectorAll(".fx-btn-row");
    if (rows.length >= 3) return;
    var row = document.createElement("div");
    row.className = "fx-btn-row";
    row.style.cssText = "display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap";
    var label = document.createElement("input");
    label.className = "fxb-label";
    label.placeholder = T("fx_btn_label");
    label.value = btn.label || "";
    label.style.flex = "1";
    var action = document.createElement("select");
    action.className = "fxb-action";
    action.style.flex = "0 0 110px";
    [["message", T("fx_action_message")], ["uri", T("fx_action_uri")]].forEach(function (pair) {
      var opt = document.createElement("option");
      opt.value = pair[0];
      opt.textContent = pair[1];
      if ((btn.action || "message") === pair[0]) opt.selected = true;
      action.appendChild(opt);
    });
    var value = document.createElement("input");
    value.className = "fxb-value";
    value.placeholder = T("fx_btn_value");
    value.value = btn.value || "";
    value.style.flex = "2";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = T("btn_delete");
    remove.addEventListener("click", function () { row.remove(); syncFlexEditor(); });
    row.append(label, action, value, remove);
    $("fx-buttons").appendChild(row);
  }

  function collectFxButtons() {
    var out = [];
    Array.prototype.forEach.call($("fx-buttons").querySelectorAll(".fx-btn-row"), function (row) {
      var label = row.querySelector(".fxb-label").value.trim();
      if (!label) return;
      out.push({
        label: label,
        action: row.querySelector(".fxb-action").value,
        value: row.querySelector(".fxb-value").value.trim()
      });
    });
    return out;
  }

  function buildFlex() {
    var bubble = { type: "bubble" };
    var heroUrl = $("fx-hero-url").value.trim();
    if ($("fx-hero-on").checked && heroUrl) {
      bubble.hero = {
        type: "image", url: heroUrl, size: "full",
        aspectRatio: $("fx-hero-ratio").value || "20:13", aspectMode: "cover"
      };
    }
    var bodyContents = [];
    if ($("fx-title").value) {
      bodyContents.push({ type: "text", text: $("fx-title").value, weight: "bold", size: "xl", wrap: true });
    }
    if ($("fx-body").value) {
      bodyContents.push({ type: "text", text: $("fx-body").value, size: "sm", color: "#666666", wrap: true });
    }
    if (bodyContents.length > 0) {
      bubble.body = { type: "box", layout: "vertical", contents: bodyContents };
    }
    var btns = collectFxButtons();
    if (btns.length > 0) {
      bubble.footer = {
        type: "box", layout: "vertical", spacing: "sm", contents: btns.map(function (b, i) {
          var act = b.action === "uri"
            ? { type: "uri", label: b.label, uri: b.value }
            : { type: "message", label: b.label, text: b.value || b.label };
          return { type: "button", style: i === 0 ? "primary" : "link", height: "sm", action: act };
        })
      };
    }
    return bubble;
  }

  function renderFlexPreview(bubble) {
    var host = $("fx-preview");
    host.replaceChildren();
    var hasContent = bubble.hero || bubble.body || bubble.footer;
    if (!hasContent) {
      var empty = document.createElement("div");
      empty.className = "msg";
      empty.textContent = T("fx_preview_empty");
      host.appendChild(empty);
      return false;
    }
    var card = document.createElement("div");
    card.style.cssText = "background:#fff;color:#111;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.35);font-family:-apple-system,'Noto Sans TC',sans-serif";
    if (bubble.hero) {
      var img = document.createElement("img");
      img.src = bubble.hero.url;
      img.alt = "";
      img.style.cssText = "display:block;width:100%;aspect-ratio:" + String(bubble.hero.aspectRatio || "20:13").replace(":", "/") + ";object-fit:cover;background:#eee";
      card.appendChild(img);
    }
    if (bubble.body) {
      var bodyBox = document.createElement("div");
      bodyBox.style.padding = "14px 16px";
      bubble.body.contents.forEach(function (c, i) {
        var p = document.createElement("div");
        p.textContent = c.text;
        p.style.cssText = i === 0 && c.weight === "bold"
          ? "font-size:17px;font-weight:700;margin-bottom:6px;white-space:pre-wrap;word-break:break-word"
          : "font-size:13px;color:#666;margin-top:4px;white-space:pre-wrap;word-break:break-word";
        bodyBox.appendChild(p);
      });
      card.appendChild(bodyBox);
    }
    if (bubble.footer) {
      var foot = document.createElement("div");
      foot.style.padding = "0 10px 12px";
      bubble.footer.contents.forEach(function (b) {
        var a = document.createElement("div");
        a.textContent = (b.action && b.action.label) || "";
        var primary = b.style === "primary";
        a.style.cssText = "text-align:center;font-size:14px;border-radius:8px;padding:9px;margin-top:8px;" +
          (primary ? "background:#242424;color:#fff;" : "border:1px solid #d0d0d0;color:#42659a;");
        foot.appendChild(a);
      });
      card.appendChild(foot);
    }
    host.appendChild(card);
    return true;
  }

  function syncFlexEditor(save) {
    var bubble = buildFlex();
    var ok = renderFlexPreview(bubble);
    $("fx-json").value = ok ? JSON.stringify(bubble, null, 2) : "";
    if (save !== false) {
      try {
        localStorage.setItem(FX_DRAFT_KEY, JSON.stringify({
          alt: $("fx-alt").value,
          heroOn: $("fx-hero-on").checked,
          heroUrl: $("fx-hero-url").value,
          ratio: $("fx-hero-ratio").value,
          title: $("fx-title").value,
          body: $("fx-body").value,
          buttons: collectFxButtons()
        }));
      } catch (e) {}
    }
    return ok;
  }

  function restoreFlexDraft() {
    var draft = null;
    try { draft = JSON.parse(localStorage.getItem(FX_DRAFT_KEY) || "null"); } catch (e) {}
    if (!draft) return;
    if (typeof draft.alt === "string") $("fx-alt").value = draft.alt;
    $("fx-hero-on").checked = draft.heroOn !== false;
    if (typeof draft.heroUrl === "string") $("fx-hero-url").value = draft.heroUrl;
    if (typeof draft.ratio === "string") $("fx-hero-ratio").value = draft.ratio;
    if (typeof draft.title === "string") $("fx-title").value = draft.title;
    if (typeof draft.body === "string") $("fx-body").value = draft.body;
    $("fx-buttons").replaceChildren();
    (Array.isArray(draft.buttons) ? draft.buttons : []).slice(0, 3).forEach(addFxButtonRow);
  }

  $("flex-editor-form").addEventListener("input", function () { syncFlexEditor(); });
  $("flex-editor-form").addEventListener("change", function () { syncFlexEditor(); });
  $("fx-btn-add").addEventListener("click", function () {
    addFxButtonRow();
    var rows = $("fx-buttons").querySelectorAll(".fx-btn-row");
    var last = rows[rows.length - 1];
    if (last) last.querySelector(".fxb-label").focus();
  });
  $("fx-fill-test").addEventListener("click", function () {
    if (!syncFlexEditor()) { $("fx-msg").textContent = T("fx_empty"); return; }
    $("test-flex-alt").value = $("fx-alt").value.trim() || "Flex 訊息";
    $("test-flex-json").value = $("fx-json").value;
    $("fx-msg").textContent = T("fx_filled");
  });
  $("fx-copy").addEventListener("click", function () {
    if (!syncFlexEditor()) { $("fx-msg").textContent = T("fx_empty"); return; }
    copyText($("fx-json").value).then(function (ok) {
      $("fx-msg").textContent = ok ? T("fx_copied") : $("fx-json").value;
    });
  });
  restoreFlexDraft();
  syncFlexEditor(false);

  setupCards([], "test");
  setInterval(refreshData, 10000);
`;
    const sidebar = `
<div class="side-section">${tr(config.language, "section_functions")}</div>
<div class="fn-list">
  <button type="button" class="fn-card active" data-fn="test">${tr(config.language, "card_test")}</button>
  <button type="button" class="fn-card" data-fn="flex-editor">${tr(config.language, "panel_flex_editor")}</button>
  <button type="button" class="fn-card" data-fn="targets-list">${tr(config.language, "card_targets")}</button>
  <button type="button" class="fn-card" data-fn="logs">${tr(config.language, "card_logs")}</button>
  <button type="button" class="fn-card" data-fn="scheduled">${tr(config.language, "card_scheduled")}</button>
</div>
<div class="side-section">${tr(config.language, "section_actions")}</div>
<div class="fn-list">
  <button type="button" class="fn-card" id="btn-relogin">${tr(config.language, "relogin")}</button>
  <button type="button" class="fn-card" id="btn-refresh">${tr(config.language, "refresh_contacts")}</button>
</div>
<p id="action-msg" class="msg" style="align-self:stretch; word-break:break-word; margin:6px 2px 0"></p>`;
    return page(tr(config.language, "title_console"), "console", body, script, { sidebar });
}
function renderSkillsHtml() {
    const skillDefs = listSkills().map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: resolveText(skill.description, config.language),
        defaultTrigger: skill.defaultTrigger,
        triggerMode: skill.triggerMode ?? "assistant",
        hideTrigger: skill.hideTrigger ?? false,
        fields: skill.fields.map((f) => ({
            ...f,
            label: resolveText(f.label, config.language),
            hint: f.hint === undefined ? undefined : resolveText(f.hint, config.language),
        })),
        ruleFields: (skill.ruleFields ?? []).map((f) => ({
            ...f,
            label: resolveText(f.label, config.language),
            hint: f.hint === undefined ? undefined : resolveText(f.hint, config.language),
        })),
        ruleKey: skill.ruleKey ?? "rules",
    }));
    const body = `
<div class="glass">
  <div class="field"><label data-i18n="lbl_assistant_enabled">啟用助理</label><input id="assistant-enabled" type="checkbox"><div class="hint" data-i18n="hint_assistant">開啟後，訊息以「名稱」開頭即會呼叫技能，例如「阿寶請幫忙 火車 台北 到 高雄」</div></div>
  <div class="field"><label data-i18n="lbl_assistant_name">助理名稱</label><input id="assistant-name" type="text" placeholder="阿寶"></div>
  <div class="actions"><button type="button" id="skills-save" data-i18n="save_settings">儲存</button><span id="skills-msg" class="msg"></span></div>
</div>

<h2 data-i18n="title_skills">技能</h2>
<div class="glass">
  <div class="field"><label data-i18n="lbl_install_skill">安裝技能（上傳 .zip）</label><span style="display:flex;gap:8px;align-items:center"><input id="skill-zip" type="file" accept=".zip,application/zip" style="flex:1"><button type="button" id="skill-install-btn" data-i18n="btn_install">安裝</button><span id="install-msg" class="msg"></span></span><div class="hint" data-i18n="hint_install">zip 內含技能的 index.js（可含 skill.json）。安裝後立即生效。</div></div>
  <div id="installed-list"></div>
</div>

<div id="skillList"></div>
`;
    const script = `
  ${HELPERS}
  var SKILL_DEFS = ${JSON.stringify(skillDefs).replace(/</g, "\\u003c")};

  function loadInstalled() {
    fetch("/skills/installed.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (d) {
        if (!d) return;
        var host = $("installed-list");
        var rows = [];
        (d.installed || []).forEach(function (s) {
          var row = document.createElement("div");
          row.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:12px;padding:6px 0;border-top:1px solid rgba(34,211,238,.12)";
          var label = document.createElement("div");
          label.textContent = s.name + (s.version ? " v" + s.version : "") + "（" + s.id + "）";
          var btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = T("btn_uninstall");
          btn.addEventListener("click", function () {
            if (!window.confirm("移除技能 " + s.id + "？")) return;
            fetch("/skills/uninstall", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: s.id })
            }).then(function (r) {
              return r.json().catch(function () { return {}; }).then(function (x) { return { ok: r.ok, data: x }; });
            }).then(function (r) {
              if (r.ok) { loadInstalled(); loadSkills(); }
              else { alert("移除失敗：" + (r.data.error || "")); }
            });
          });
          row.append(label, btn);
          rows.push(row);
        });
        if (rows.length === 0) {
          var empty = document.createElement("div");
          empty.className = "msg";
          empty.textContent = T("no_installed");
          host.replaceChildren(empty);
        } else {
          host.replaceChildren.apply(host, rows);
        }
      })
      .catch(function () {});
  }

  $("skill-install-btn").addEventListener("click", function () {
    var input = $("skill-zip");
    if (!input.files || !input.files[0]) { $("install-msg").textContent = "請先選擇 zip"; return; }
    var file = input.files[0];
    $("install-msg").textContent = "上傳安裝中…";
    file.arrayBuffer().then(function (buf) {
      return fetch("/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buf
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (x) { return { ok: r.ok, data: x }; });
    }).then(function (r) {
      if (!r.ok) { $("install-msg").textContent = "安裝失敗：" + (r.data.error || ""); return; }
      $("install-msg").textContent = "已安裝：" + r.data.id + "（" + r.data.files + " 檔）";
      input.value = "";
      loadInstalled();
      loadSkills();
    }).catch(function () { $("install-msg").textContent = "安裝失敗"; });
  });

  function skillDef(id) {
    for (var i = 0; i < SKILL_DEFS.length; i++) if (SKILL_DEFS[i].id === id) return SKILL_DEFS[i];
    return null;
  }

  function fieldWrap(labelText, input) {
    var wrap = document.createElement("div");
    wrap.className = "field";
    var label = document.createElement("label");
    label.textContent = labelText;
    wrap.append(label, input);
    return wrap;
  }

  function buildFieldInput(f) {
    var input;
    if (f.type === "textarea") {
      input = document.createElement("textarea");
      input.style.minHeight = "110px";
    } else if (f.type === "select") {
      input = document.createElement("select");
      (f.options || []).forEach(function (opt) {
        var o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        input.appendChild(o);
      });
    } else {
      input = document.createElement("input");
      input.type = f.secret ? "password" : "text";
    }
    input.className = "sf";
    input.setAttribute("data-key", f.key);
    input.style.width = "100%";
    if (f.hint) input.placeholder = f.hint;
    return input;
  }

  function buildFileField(f) {
    var wrap = document.createElement("div");
    var input = document.createElement("input");
    input.type = "text";
    input.className = "sf";
    input.setAttribute("data-key", f.key);
    input.style.flex = "1";
    if (f.hint) input.placeholder = f.hint;
    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.style.display = "none";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = T("btn_upload");
    var status = document.createElement("span");
    status.className = "msg";
    btn.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
      if (!fileInput.files || !fileInput.files[0]) return;
      var file = fileInput.files[0];
      status.textContent = "上傳中…";
      file.arrayBuffer().then(function (buf) {
        return fetch("/settings/upload", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
          body: buf
        });
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, data: data }; });
      }).then(function (r) {
        if (!r.ok) { status.textContent = "失敗：" + (r.data.error || ""); return; }
        input.value = r.data.path;
        status.textContent = "已上傳（" + r.data.bytes + " bytes）";
      }).catch(function () { status.textContent = "上傳失敗"; });
      fileInput.value = "";
    });
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;align-items:center";
    row.append(input, btn, fileInput, status);
    wrap.append(row);
    return wrap;
  }

  function buildRuleRow(def, rule) {
    rule = rule || {};
    var row = document.createElement("div");
    row.className = "rule-row";
    row.style.cssText = "border:1px solid rgba(34,211,238,.2);border-radius:10px;padding:10px 12px;margin-bottom:8px;background:rgba(0,0,0,.18)";
    (def.ruleFields || []).forEach(function (f) {
      var input = buildFieldInput(f);
      input.className = "rf";
      input.value = rule[f.key] != null ? String(rule[f.key]) : (f.type === "select" && f.options ? f.options[0].value : "");
      if (f.type === "select") input.value = rule[f.key] || (f.options ? f.options[0].value : "");
      row.appendChild(fieldWrap(f.label, input));
    });
    var actions = document.createElement("div");
    actions.className = "actions";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = T("btn_delete_rule");
    remove.addEventListener("click", function () { row.remove(); });
    actions.appendChild(remove);
    row.appendChild(actions);
    return row;
  }

  var openCards = [];

  function setCardOpen(entry, value) {
    entry.open = value;
    entry.body.hidden = !value;
    entry.toggleBtn.textContent = value ? "\u25be" : "\u25b8";
    entry.card.classList.toggle("open", value);
  }

  function openCard(entry) {
    openCards.forEach(function (other) { if (other !== entry) setCardOpen(other, false); });
    setCardOpen(entry, true);
  }

  function buildSkillCard(skill) {
    skill = skill || {};
    var def = skillDef(skill.id);
    if (!def) return null;
    var enabledFlag = skill.enabled === true;

    var card = document.createElement("div");
    card.className = "glass skill-card";
    card.setAttribute("data-skill-id", def.id);

    var head = document.createElement("div");
    head.className = "skill-head";
    var title = document.createElement("div");
    var h = document.createElement("div");
    h.style.cssText = "font-weight:700;color:#a5f3fc;font-size:16px";
    h.textContent = def.name;
    title.appendChild(h);
    var desc = document.createElement("div");
    desc.className = "msg skill-desc";
    desc.textContent = def.description || "";
    title.appendChild(desc);
    var healthBox = document.createElement("div");
    healthBox.className = "skill-health";
    healthBox.style.cssText = "margin-top:4px;font-size:12px";
    healthBox.setAttribute("data-skill-id", def.id);
    title.appendChild(healthBox);
    var enableWrap = document.createElement("label");
    enableWrap.style.cssText = "display:flex;align-items:center;gap:8px;white-space:nowrap";
    var enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "sk-enabled";
    enabled.checked = enabledFlag;
    enableWrap.append(enabled, document.createTextNode(T("lbl_enabled")));

    var toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "sk-toggle";
    toggleBtn.title = T("lbl_expand");

    var right = document.createElement("div");
    right.style.cssText = "display:flex;align-items:center;gap:8px;white-space:nowrap";
    right.append(enableWrap, toggleBtn);

    head.append(title, right);
    card.appendChild(head);

    var body = document.createElement("div");
    body.className = "skill-body";

    if (def.triggerMode === "any") {
      var anyNote = document.createElement("div");
      anyNote.className = "msg";
      anyNote.style.cssText = "margin:4px 0 10px";
      anyNote.textContent = T("skill_trigger_any");
      body.appendChild(anyNote);
    } else if (!def.hideTrigger) {
      var trigger = document.createElement("input");
      trigger.type = "text";
      trigger.className = "sk-trigger";
      trigger.value = skill.trigger || def.defaultTrigger || "";
      trigger.placeholder = def.defaultTrigger || T("lbl_trigger");
      body.appendChild(fieldWrap(T("lbl_trigger"), trigger));
    }

    (def.fields || []).forEach(function (f) {
      if (f.type === "file") {
        body.appendChild(fieldWrap(f.label, buildFileField(f)));
        return;
      }
      var input = buildFieldInput(f);
      input.value = (skill.config && skill.config[f.key]) || (f.type === "select" && f.options ? f.options[0].value : "");

      if (f.key === "model") {
        var listId = "models-" + def.id;
        var dl = document.createElement("datalist");
        dl.id = listId;
        input.setAttribute("list", listId);
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = T("btn_list_models");
        var msg = document.createElement("span");
        msg.className = "msg";
        btn.addEventListener("click", function () {
          msg.textContent = "…";
          var cfg = {};
          Array.prototype.forEach.call(card.querySelectorAll(".sf"), function (el) {
            cfg[el.getAttribute("data-key")] = el.value.trim();
          });
          fetch("/skills/llm/models", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(cfg)
          }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; });
          }).then(function (r) {
            if (!r.ok) { msg.textContent = "失敗：" + (r.data.error || ""); return; }
            dl.replaceChildren.apply(dl, (r.data.models || []).map(function (m) {
              var o = document.createElement("option");
              o.value = m;
              return o;
            }));
            msg.textContent = "共 " + (r.data.models || []).length + " 個";
            if (!input.value && r.data.models && r.data.models.length) input.value = r.data.models[0];
          }).catch(function () { msg.textContent = "讀取失敗"; });
        });
        var row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px;align-items:center";
        row.append(input, btn, msg);
        body.appendChild(fieldWrap(f.label, row));
        body.appendChild(dl);
        return;
      }

      body.appendChild(fieldWrap(f.label, input));
    });

    if (def.ruleFields && def.ruleFields.length > 0) {
      var host = document.createElement("div");
      host.className = "rule-list";
      var parsed = [];
      try { parsed = JSON.parse((skill.config && skill.config[def.ruleKey]) || "[]") || []; } catch (e) { parsed = []; }
      if (parsed.length === 0) parsed = [{}];
      parsed.forEach(function (r) { host.appendChild(buildRuleRow(def, r)); });
      var ruleActions = document.createElement("div");
      ruleActions.className = "actions";
      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.textContent = T("btn_add_rule");
      addBtn.addEventListener("click", function () { host.appendChild(buildRuleRow(def, {})); });
      ruleActions.appendChild(addBtn);
      body.appendChild(host);
      body.appendChild(ruleActions);
    }

    card.appendChild(body);

    var entry = { card: card, body: body, toggleBtn: toggleBtn, open: false };
    openCards.push(entry);
    setCardOpen(entry, false); // 預設全部收合

    toggleBtn.addEventListener("click", function () {
      if (entry.open) setCardOpen(entry, false);
      else openCard(entry);
    });

    enabled.addEventListener("change", function () {
      // 啟用後自動展開（並收合其他卡片），取消啟用則收合
      if (enabled.checked) openCard(entry);
      else setCardOpen(entry, false);
    });

    return card;
  }

  function renderSkillList(skills) {
    openCards = [];
    var byId = {};
    (skills || []).forEach(function (s) { byId[s.id] = s; });
    var list = $("skillList");
    var cards = [];
    SKILL_DEFS.forEach(function (def) {
      var card = buildSkillCard(byId[def.id] || { id: def.id, enabled: false, trigger: def.defaultTrigger, config: {} });
      if (card) cards.push(card);
    });
    if (cards.length === 0) {
      var empty = document.createElement("div");
      empty.className = "glass msg";
      empty.textContent = T("no_skills");
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren.apply(list, cards);
  }

  function collectSkills() {
    var out = [];
    var cards = $("skillList").querySelectorAll(".skill-card");
    Array.prototype.forEach.call(cards, function (card) {
      var id = card.getAttribute("data-skill-id") || "";
      var def = skillDef(id);
      if (!def) return;
      var config = {};
      Array.prototype.forEach.call(card.querySelectorAll(".sf"), function (input) {
        config[input.getAttribute("data-key")] = input.value.trim();
      });
      if (def.ruleFields && def.ruleFields.length > 0) {
        var rules = [];
        Array.prototype.forEach.call(card.querySelectorAll(".rule-row"), function (rowEl) {
          var rule = {};
          Array.prototype.forEach.call(rowEl.querySelectorAll(".rf"), function (input) {
            rule[input.getAttribute("data-key")] = input.value.trim();
          });
          if (rule.keyword && rule.keyword.length > 0) rules.push(rule);
        });
        config[def.ruleKey] = JSON.stringify(rules);
      }
      out.push({
        id: id,
        enabled: card.querySelector(".sk-enabled").checked,
        trigger: card.querySelector(".sk-trigger") ? card.querySelector(".sk-trigger").value.trim() : "",
        config: config
      });
    });
    return out.filter(function (s) { return s.id; });
  }

  function loadSkills() {
    fetch("/settings.json", { cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) { window.location.href = "/login"; return null; }
        return res.ok ? res.json() : null;
      })
      .then(function (s) {
        if (!s) return;
        $("assistant-enabled").checked = !!(s.assistant && s.assistant.enabled);
        $("assistant-name").value = (s.assistant && s.assistant.name) || "阿寶";
        renderSkillList(s.skills);
        loadHealth();
      })
      .catch(function () {});
  }

  function loadHealth() {
    fetch("/skills/health", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.health) return;
        Array.prototype.forEach.call(document.querySelectorAll(".skill-health"), function (box) {
          var id = box.getAttribute("data-skill-id");
          var list = data.health[id];
          if (!list || list.length === 0) return;
          var parts = list.map(function (h) {
            return (h.ok ? "\u2705 " : "\u274c ") + h.name + (h.detail ? "（" + h.detail + "）" : "");
          });
          box.textContent = parts.join("　");
        });
      })
      .catch(function () {});
  }

  $("skills-save").addEventListener("click", function () {
    $("skills-msg").textContent = "儲存中…";
    var payload = {
      assistant: {
        enabled: $("assistant-enabled").checked,
        name: $("assistant-name").value.trim() || "阿寶"
      },
      skills: collectSkills()
    };
    fetch("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (res.status === 401) { window.location.href = "/login"; return null; }
      return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, data: d }; });
    }).then(function (r) {
      if (!r) return;
      $("skills-msg").textContent = r.ok ? T("saved") : ("失敗：" + (r.data.error || ""));
    }).catch(function () { $("skills-msg").textContent = "失敗"; });
  });

  loadSkills();
  loadInstalled();
`;
    return page(tr(config.language, "title_skills"), "skills", body, script);
}
function renderLoginHtml(lang: Lang) {
    const shortLabels = { zh: "中", en: "EN", ja: "日" };
    const langMenu = LANGS.map((code) => `<button type="button" class="login-lang-item${code === lang ? " active" : ""}" data-lang="${code}">${LANG_LABELS[code]}</button>`).join("");
    const body = `
<div class="login-center">
  <div class="glass login-card">
    <div class="login-head">
      <h2 class="neon-text">LINE Webhook</h2>
      <div class="login-lang" id="login-lang">
        <button type="button" class="login-lang-toggle" id="login-lang-toggle">${shortLabels[lang] || "中"} &#9662;</button>
        <div class="login-lang-menu" id="login-lang-menu" hidden>${langMenu}</div>
      </div>
    </div>
    <div class="sub">${tr(lang, "login_sub")}</div>
    <form id="login-form">
      <input id="login-user" placeholder="${tr(lang, "login_user")}" autocomplete="username" required>
      <input id="login-pass" type="password" placeholder="${tr(lang, "login_pass")}" autocomplete="current-password" required>
      <button type="submit">${tr(lang, "login_submit")}</button>
      <p id="login-msg" class="msg" style="margin:12px 0 0"></p>
    </form>
  </div>
</div>
`;
    const script = `
  ${HELPERS}
  (function () {
    function switchLang(code) {
      fetch("/login/language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: code })
      }).then(function () { window.location.reload(); })
        .catch(function () { window.location.reload(); });
    }
    var toggle = $("login-lang-toggle");
    var menu = $("login-lang-menu");
    if (toggle && menu) {
      toggle.addEventListener("click", function (e) {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
      });
      menu.addEventListener("click", function (e) { e.stopPropagation(); });
      document.addEventListener("click", function () { menu.hidden = true; });
    }
    Array.prototype.forEach.call(document.querySelectorAll(".login-lang-item"), function (btn) {
      btn.addEventListener("click", function () { switchLang(btn.getAttribute("data-lang")); });
    });
  })();
  $("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    $("login-msg").textContent = "登入中…";
    fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: $("login-user").value, pass: $("login-pass").value })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok) { window.location.href = "/dashboard"; }
        else { $("login-msg").textContent = "登入失敗：" + (data.error || ""); }
      });
    }).catch(function () { $("login-msg").textContent = "登入失敗"; });
  });
`;
    return page(tr(lang, "title_login"), "", body, script, { showNav: false, showTitle: false, lang });
}
let readmeCache: string | null = null;
function readmeHtml() {
    if (readmeCache !== null)
        return readmeCache;
    try {
        const markdown = readFileSync("./README.md", "utf8");
        // README 雖為本機檔案，仍移除 script 區塊避免意外執行。
        const html = marked.parse(markdown, { async: false });
        readmeCache = String(html).replace(/<script[\s\S]*?<\/script\s*>/gi, "");
    }
    catch (error) {
        readmeCache = `<p>無法讀取 README.md：${String(error)}</p>`;
    }
    return readmeCache;
}
function renderReadmeHtml() {
    const body = `<div class="glass md">${readmeHtml()}</div>`;
    return page("ReadMe", "readme", body, "");
}
function renderMessagesHtml() {
    const body = `
<div class="glass glass-hover">
<h2 style="margin-top:0" data-i18n="title_messages">收到的訊息</h2>
<div style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
  <input id="message-search" data-i18n-ph="ph_search" placeholder="搜尋關鍵字" style="width:220px">
  <input id="message-chat" placeholder="MID" style="width:200px">
  <button type="button" id="message-export-json">JSON</button>
  <button type="button" id="message-export-csv">CSV</button>
  <span id="message-count" class="msg"></span>
</div>
<table><thead><tr><th data-i18n="th_time">時間</th><th data-i18n="th_source">來源</th><th data-i18n="th_chat">對話</th><th data-i18n="th_content">內容</th></tr></thead><tbody id="messages"></tbody></table>
</div>
`;
    const script = `
  ${HELPERS}
  var lastMessages = [];
  function render(data) {
    var bodyEl = $("messages");
    var list = data.messages || [];
    lastMessages = list;
    if (list.length === 0) {
      bodyEl.replaceChildren(emptyRow(4));
      $("message-count").textContent = "";
      return;
    }
    $("message-count").textContent = list.length;
    bodyEl.replaceChildren.apply(bodyEl, list.map(function (m) {
      var src = m.fromName ? m.fromName + " (" + m.fromMid + ")" : m.fromMid;
      var chat = m.chatMid;
      if (m.chatType) chat = m.chatType + " " + m.chatMid;
      return tr(td(m.time), td(src), td(chat, "mono"), td(m.text));
    }));
  }

  function queryString() {
    var parts = [];
    var q = $("message-search").value.trim();
    var chat = $("message-chat").value.trim();
    if (q) parts.push("q=" + encodeURIComponent(q));
    if (chat) parts.push("chat=" + encodeURIComponent(chat));
    return parts.length > 0 ? "?" + parts.join("&") : "";
  }

  function refresh() {
    fetch("/messages.json" + queryString(), { cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) { window.location.href = "/login"; return null; }
        return res.ok ? res.json() : null;
      })
      .then(function (data) { if (data) render(data); })
      .catch(function () {});
  }

  function download(filename, text, mime) {
    var blob = new Blob(["\uFEFF" + text], { type: mime + ";charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function csvCell(v) {
    var s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  $("message-export-json").addEventListener("click", function () {
    download("messages.json", JSON.stringify(lastMessages, null, 2), "application/json");
  });
  $("message-export-csv").addEventListener("click", function () {
    var rows = [["time", "fromName", "fromMid", "chatMid", "chatType", "text"]];
    lastMessages.forEach(function (m) {
      rows.push([m.time, m.fromName, m.fromMid, m.chatMid, m.chatType, m.text].map(csvCell));
    });
    download("messages.csv", rows.map(function (r) { return r.join(","); }).join("\n"), "text/csv");
  });

  var searchTimer = null;
  [$("message-search"), $("message-chat")].forEach(function (el) {
    el.addEventListener("input", function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(refresh, 300);
    });
  });

  refresh();
  setInterval(refresh, 5000);
`;
    return page(tr(config.language, "title_messages"), "messages", body, script);
}
/** 各平台服務摘要（給 dashboard / status 用）。 */
function platformSummaries() {
    return listServices().map((service) => ({
        platform: service.platform,
        targets: service.listTargets().length,
        queue: service.getQueueStats(),
    }));
}
/** 固定時間比較字串（避免以回應時間洩漏密鑰）。 */
function constantTimeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
/**
 * 產生 /webhook 系列的發送處理器，讓 LINE 與其他平台共用同一套請求解析/排程/轉發邏輯。
 * resolve 在請求時才解析服務，讓未啟用的平台回 503 而非啟動即失敗。
 */
function makeWebhookSender(resolveService: (req: Request) => IMessagingService | undefined) {
    return async (req: Request, res: Response): Promise<void> => {
        const service = resolveService(req);
        if (!service) {
            res.status(503).json({ ok: false, error: "平台服務未啟用" });
            return;
        }
        const body = asRecord(req.body) ?? {};
        const targets = parseTargets(body.to);
        const allowedExtraTo = Array.isArray(body.messages) &&
            body.messages.every((item: unknown) => {
                const record = asRecord(item);
                return record && typeof record.to === "string" && record.to.trim();
            });
        if (targets.length === 0 && !allowedExtraTo) {
            res.status(400).json({ ok: false, error: "to 必填（字串或字串陣列）" });
            return;
        }
        const resolved = resolveInputs(body, targets);
        if ("error" in resolved) {
            res.status(400).json({ ok: false, error: resolved.error });
            return;
        }
        const inputs = resolved;
        const { runAt, error: runAtError } = resolveRunAt(body);
        if (runAtError) {
            res.status(400).json({ ok: false, error: runAtError });
            return;
        }
        const repeatChecked = validateRepeat(body.repeat);
        if ("error" in repeatChecked) {
            res.status(400).json({ ok: false, error: repeatChecked.error });
            return;
        }
        const repeat = repeatChecked.repeat;
        const dedupKey = typeof req.header("x-idempotency-key") === "string"
            ? (req.header("x-idempotency-key") as string).trim()
            : "";
        if (dedupKey && isDuplicateIdempotency(dedupKey)) {
            logger.info("重複的 idempotency key，略過", { ip: req.ip, dedupKey });
            res.json({ ok: true, duplicate: true });
            return;
        }
        try {
            if (runAt !== undefined) {
                const job = service.schedule(inputs, runAt, repeat || undefined);
                if (dedupKey)
                    markIdempotency(dedupKey);
                logger.info("訊息已排程", {
                    ip: req.ip,
                    platform: service.platform,
                    count: inputs.length,
                    runAt: job.runAt,
                    repeat: job.repeat,
                });
                res.json({
                    ok: true,
                    scheduled: true,
                    id: job.id,
                    runAt: job.runAt,
                    repeat: job.repeat,
                    count: inputs.length,
                });
                return;
            }
            await service.sendAdvanced(inputs);
            if (dedupKey)
                markIdempotency(dedupKey);
            logger.info("訊息已轉發", { ip: req.ip, platform: service.platform, count: inputs.length });
            res.json({ ok: true, count: inputs.length });
        }
        catch (error) {
            logger.error("轉發失敗", {
                ip: req.ip,
                platform: service.platform,
                targets,
                error: error instanceof Error ? error.message : String(error),
            });
            sendError(res, error);
        }
    };
}
export function createServer(line: IMessagingService): express.Express {
    const app = express();
    app.disable("x-powered-by");
    // 只信任本機迴路 proxy，避免直接對外暴露時被偽造 X-Forwarded-For 繞過 IP 限制。
    app.set("trust proxy", "loopback");
    app.use((_req, res, next) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
        next();
    });
    const authEnabled = (config.hmacEnabled && config.hmacSecret)
        || (config.webhookTokenEnabled && config.webhookToken)
        || (config.apiTokenEnabled && (config.apiToken || config.apiTokens.some((item) => item.token)));
    if (!authEnabled) {
        logger.warn("webhook 未啟用任何驗證（HMAC/Token/API Token），將接受所有來源呼叫");
    }
    app.use(express.json({
        limit: `${config.maxBodyMb}mb`,
        verify: (req, _res, buf) => {
            (req as RawBodyRequest).rawBody = buf;
        },
    }));
    app.get("/", (_req, res) => res.redirect("/dashboard"));
    app.get("/health", (_req, res) => {
        const ok = getState().status === "已登入";
        res.json({ status: ok ? "ok" : "bad" });
    });
    app.get("/dashboard", statusAccess, requireSessionOrApi("admin"), (_req, res) => {
        res.type("html").send(renderDashboardHtml());
    });
    app.get("/dashboard.json", statusAccess, requireSessionOrApi("read"), (req, res) => {
        res.set("Cache-Control", "no-store");
        const platform = typeof req.query.platform === "string" ? req.query.platform : "";
        const service = platform && platform !== "line" ? getService(platform as Platform) : line;
        const svc = service ?? line;
        // 每個在線平台各自的發送統計（分開呈現）。
        const statsByPlatform: Record<string, ReturnType<typeof getStats>> = {};
        for (const p of listServices()) {
            statsByPlatform[p.platform] = getStats(config.statsDays, p.platform);
        }
        res.json({
            state: getState(),
            logs: logger.getRecent(),
            targets: svc.listTargets(),
            queue: svc.getQueueStats(),
            scheduled: svc.listScheduled(),
            platforms: platformSummaries(),
            stats: getStats(config.statsDays, svc.platform),
            statsByPlatform,
            messages: getMessages().slice(-50),
        });
    });
    app.get("/status.json", statusAccess, requireSessionOrApi("read"), (req, res) => {
        res.set("Cache-Control", "no-store");
        const platform = typeof req.query.platform === "string" ? req.query.platform : "";
        const service = platform && platform !== "line" ? getService(platform as Platform) : line;
        res.json({
            state: getState(),
            logs: logger.getRecent(),
            targets: (service ?? line).listTargets(),
            queue: (service ?? line).getQueueStats(),
            scheduled: (service ?? line).listScheduled(),
            platforms: platformSummaries(),
        });
    });
    app.get("/tokens/usage.json", statusAccess, requireSessionOrApi("admin"), (_req, res) => {
        res.set("Cache-Control", "no-store");
        res.json({ usage: getTokenUsage() });
    });
    app.get("/status/qr", statusAccess, requireSession, async (_req, res) => {
        const { qrUrl } = getState();
        if (!qrUrl) {
            res.status(404).send("no qr");
            return;
        }
        try {
            const buffer = await QRCode.toBuffer(qrUrl, { width: 360, margin: 1 });
            res.set("Cache-Control", "no-store");
            res.type("png").send(buffer);
        }
        catch {
            res.status(500).send("qr error");
        }
    });
    app.get("/login", statusAccess, (req, res) => {
        if (hasSession(req)) {
            res.redirect("/dashboard");
            return;
        }
        res.type("html");
        res.set("Cache-Control", "no-store");
        res.send(renderLoginHtml(readLangCookie(req) ?? config.language));
    });
    // 登入頁的語言偏好只存瀏覽器 cookie，不寫入設定檔（未登入不可寫設定）。
    app.post("/login/language", statusAccess, (req, res) => {
        const body = asRecord(req.body) ?? {};
        if (!isLang(body.lang)) {
            res.status(400).json({ ok: false, error: "unsupported language" });
            return;
        }
        res.setHeader(
            "Set-Cookie",
            `${LANG_COOKIE}=${body.lang}; Path=/; Max-Age=${LANG_COOKIE_MAX_AGE}; SameSite=Lax`,
        );
        res.json({ ok: true, language: body.lang });
    });
    app.post("/login", statusAccess, loginRateLimit, (req, res) => {
        const body = req.body;
        const user = typeof body?.user === "string" ? body.user : "";
        const pass = typeof body?.pass === "string" ? body.pass : "";
        if (!verifyCredentials(user, pass)) {
            logger.warn("登入失敗", { ip: req.ip });
            res.status(401).json({ ok: false, error: "帳號或密碼錯誤" });
            return;
        }
        createSession(req, res);
        logger.info("登入成功", { ip: req.ip });
        res.json({ ok: true });
    });
    // 舊路徑已移除：/settings/login、/settings/logout
    app.post("/logout", requireSameOrigin, (req, res) => {
        destroySession(req, res);
        res.json({ ok: true });
    });
    // 檢查 session 是否有效（不續期，供前端偵測逾時與同步倒數）
    app.get("/settings/session", statusAccess, (req, res) => {
        const remainingMs = sessionRemainingMs(req, false);
        if (remainingMs !== null) {
            res.json({ ok: true, remainingMs });
            return;
        }
        res.status(401).json({ ok: false, error: "需要登入" });
    });
    // 使用者有操作時續期（含重發 cookie，否則瀏覽器會在登入滿 5 分鐘後丟掉 cookie）
    app.post("/settings/touch", statusAccess, requireSameOrigin, (req, res) => {
        const remainingMs = refreshSession(req, res);
        if (remainingMs !== null) {
            res.json({ ok: true, remainingMs });
            return;
        }
        res.status(401).json({ ok: false, error: "需要登入" });
    });
    app.get("/console", statusAccess, requireSessionOrApi("admin"), (_req, res) => {
        res.type("html").send(renderConsoleHtml());
    });
    app.get("/skills", statusAccess, requireSessionOrApi("admin"), (_req, res) => {
        res.type("html").send(renderSkillsHtml());
    });
    app.get("/skills/health", statusAccess, requireSessionOrApi("read"), async (_req, res) => {
        const result: Record<string, Array<{ name: string; ok: boolean; detail?: string }>> = {};
        await Promise.all(listSkills().map(async (skill) => {
            if (!skill.health)
                return;
            try {
                result[skill.id] = await skill.health();
            }
            catch (error) {
                result[skill.id] = [{ name: "health", ok: false, detail: String(error) }];
            }
        }));
        res.json({ health: result });
    });
    app.post("/skills/llm/models", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, async (req, res) => {
        const body = asRecord(req.body) ?? {};
        const raw: Record<string, string> = {};
        for (const [k, v] of Object.entries(body))
            if (typeof v === "string")
                raw[k] = v;
        try {
            const cfg = llmConfigFrom(raw);
            const models = await listModels(cfg);
            res.json({ ok: true, models });
        }
        catch (error) {
            res.status(400).json({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
    app.get("/skills/installed.json", statusAccess, requireSessionOrApi("read"), (_req, res) => {
        res.json({
            installed: listInstalled(),
            builtin: listSkills()
                .filter((s) => isBuiltinSkill(s.id))
                .map((s) => ({ id: s.id, name: s.name })),
        });
    });
    app.post("/skills/install", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, express.raw({ type: "*/*", limit: `${config.maxBodyMb}mb` }), async (req, res) => {
        const data = Buffer.isBuffer(req.body) ? req.body : (req as RawBodyRequest).rawBody;
        if (!data || data.length === 0) {
            res.status(400).json({ ok: false, error: "沒有收到檔案內容" });
            return;
        }
        try {
            const result = await installZip(data);
            res.json({ ok: true, ...result });
        }
        catch (error) {
            res.status(400).json({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
    app.post("/skills/uninstall", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, async (req, res) => {
        const body = asRecord(req.body) ?? {};
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) {
            res.status(400).json({ ok: false, error: "id 必填" });
            return;
        }
        const removed = await uninstallSkill(id);
        if (!removed) {
            res.status(404).json({ ok: false, error: "找不到技能" });
            return;
        }
        res.json({ ok: true });
    });
    app.post("/skills", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, (req, res) => {
        try {
            const body = asRecord(req.body) ?? {};
            const assistant = asRecord(body.assistant);
            const skills = Array.isArray(body.skills) ? body.skills : [];
            const current = currentSettings();
            const saved = saveSettings({
                ...current,
                assistant: assistant
                    ? {
                        enabled: assistant.enabled === true,
                        name: typeof assistant.name === "string" && assistant.name.trim() ? assistant.name.trim() : "阿寶",
                    }
                    : current.assistant,
                skills: skills.map((item: unknown) => {
                    const s = asRecord(item) ?? {};
                    const config = asRecord(s.config) ?? {};
                    const configOut: Record<string, string> = {};
                    for (const [k, v] of Object.entries(config))
                        configOut[k] = String(v ?? "");
                    return {
                        id: typeof s.id === "string" ? s.id : "",
                        enabled: s.enabled === true,
                        trigger: typeof s.trigger === "string" ? s.trigger : "",
                        config: configOut,
                    };
                }),
            });
            res.json({ ok: true, assistant: saved.assistant, skills: saved.skills });
        }
        catch (error) {
            res.status(400).json({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
    app.get("/settings", statusAccess, requireSessionOrApi("admin"), (_req, res) => {
        res.type("html").send(renderSettingsHtml());
    });
    app.get("/readme", statusAccess, requireSessionOrApi("admin"), (_req, res) => {
        res.type("html").send(renderReadmeHtml());
    });
    app.get("/messages", statusAccess, requireSessionOrApi("admin"), (_req, res) => {
        res.type("html").send(renderMessagesHtml());
    });
    app.get("/messages.json", statusAccess, requireSessionOrApi("read"), (req, res) => {
        res.set("Cache-Control", "no-store");
        const q = req.query;
        const str = (v: unknown): string => (typeof v === "string" ? v : "");
        const num = Number(str(q.limit));
        res.json({
            messages: searchMessages({
                q: str(q.q),
                chat: str(q.chat),
                limit: Number.isFinite(num) ? num : undefined,
            }),
        });
    });
    app.get("/settings.json", statusAccess, requireSessionOrApi("admin"), (_req, res) => {
        res.set("Cache-Control", "no-store");
        res.json(currentSettings());
    });
    app.get("/settings/export", statusAccess, requireSessionOrApi("admin"), (_req, res) => {
        const data = currentSettings();
        res.set("Cache-Control", "no-store");
        res.setHeader("Content-Disposition", `attachment; filename="linehook-settings-${Date.now()}.json"`);
        res.type("application/json").send(JSON.stringify(data, null, 2));
    });
    app.post("/settings/import", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, (req, res) => {
        try {
            const body = asRecord(req.body) ?? {};
            const incoming = body.settings ?? req.body;
            const saved = saveSettings(incoming);
            reloadMessages();
            logger.info("已匯入設定", { ip: req.ip });
            res.json({ ok: true, settings: saved });
        }
        catch (error) {
            res.status(400).json({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
    app.post("/settings", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, (req, res) => {
        try {
            const saved = saveSettings(req.body);
            reloadMessages();
            res.json({ ok: true, settings: saved });
        }
        catch (error) {
            res.status(400).json({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
    app.post("/settings/language", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, (req, res) => {
        const body = asRecord(req.body) ?? {};
        if (!isLang(body.lang)) {
            res.status(400).json({ ok: false, error: "unsupported language" });
            return;
        }
        try {
            saveSettings({ ...currentSettings(), language: body.lang });
            res.json({ ok: true, language: body.lang });
        }
        catch (error) {
            res.status(500).json({ ok: false, error: String(error) });
        }
    });
    app.post("/settings/password", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, (req, res) => {
        const body = asRecord(req.body) ?? {};
        const current = typeof body.current === "string" ? body.current : "";
        const next = typeof body.next === "string" ? body.next : "";
        const result = changePassword(current, next);
        if (!result.ok) {
            res.status(400).json({ ok: false, error: result.error ?? "變更失敗" });
            return;
        }
        res.json({ ok: true });
    });
    app.post("/settings/upload", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, express.raw({ type: "*/*", limit: `${config.maxBodyMb}mb` }), (req, res) => {
        let name: string;
        try {
            name = decodeURIComponent(String(req.header("x-filename") ?? "upload")).trim() || "upload";
        }
        catch {
            res.status(400).json({ ok: false, error: "檔名編碼錯誤" });
            return;
        }
        const data = Buffer.isBuffer(req.body) ? req.body : (req as RawBodyRequest).rawBody;
        if (!data || data.length === 0) {
            res.status(400).json({ ok: false, error: "沒有收到檔案內容" });
            return;
        }
        try {
            mkdirSync(config.uploadsPath, { recursive: true });
            const safe = basename(name).replace(/[^\w.\-]+/g, "_") || "upload.bin";
            const stored = `${Date.now()}-${safe}`;
            const fullPath = resolve(config.uploadsPath, stored);
            writeFileSync(fullPath, data);
            logger.info("已上傳檔案", { file: stored, bytes: data.length });
            // 只回傳上傳目錄內的相對檔名，不暴露伺服器絕對路徑。
            res.json({ ok: true, path: stored, filename: safe, bytes: data.length });
        }
        catch (error) {
            res.status(500).json({ ok: false, error: `儲存失敗：${String(error)}` });
        }
    });
    app.post("/settings/relogin", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, (_req, res) => {
        logger.info("手動觸發重新登入");
        void line.recover();
        res.json({ ok: true });
    });
    app.post("/settings/refresh", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, async (_req, res) => {
        try {
            await line.refreshContacts();
            res.json({ ok: true });
        }
        catch (error) {
            sendError(res, error);
        }
    });
    app.post("/settings/test", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, async (req, res) => {
        const body = asRecord(req.body) ?? {};
        const to = typeof body.to === "string" ? body.to.trim() : "";
        if (!to) {
            res.status(400).json({ ok: false, error: "to 必填" });
            return;
        }
        // 可指定平台（LINE / Telegram）；未指定則用 LINE，維持舊行為。
        const platform = typeof body.platform === "string" ? body.platform.trim() : "";
        const target = platform && platform !== "line" ? getService(platform as Platform) : line;
        if (!target) {
            res.status(400).json({ ok: false, error: `平台未啟用：${platform}` });
            return;
        }
        const parsed = resolveInputs({ ...body, to }, [to]);
        if ("error" in parsed) {
            res.status(400).json({ ok: false, error: parsed.error });
            return;
        }
        const { runAt, error: runAtError } = resolveRunAt(body);
        if (runAtError) {
            res.status(400).json({ ok: false, error: runAtError });
            return;
        }
        const repeatChecked = validateRepeat(body.repeat);
        if ("error" in repeatChecked) {
            res.status(400).json({ ok: false, error: repeatChecked.error });
            return;
        }
        const repeat = repeatChecked.repeat;
        try {
            if (runAt !== undefined) {
                const job = target.schedule(parsed, runAt, repeat || undefined);
                res.json({ ok: true, scheduled: true, id: job.id, runAt: job.runAt, repeat: job.repeat });
                return;
            }
            await target.sendAdvanced(parsed);
            res.json({ ok: true });
        }
        catch (error) {
            sendError(res, error);
        }
    });
    app.post("/settings/scheduled/cancel", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, (req, res) => {
        const body = asRecord(req.body) ?? {};
        const id = typeof body.id === "string" ? body.id : "";
        if (!id || !line.cancelScheduled(id)) {
            res.status(404).json({ ok: false, error: "找不到排程" });
            return;
        }
        res.json({ ok: true });
    });
    app.post("/settings/scheduled/update", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, (req, res) => {
        const body = asRecord(req.body) ?? {};
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) {
            res.status(400).json({ ok: false, error: "id 必填" });
            return;
        }
        const patch: { runAt?: number; repeat?: string | null } = {};
        if (body.delaySec !== undefined && body.delaySec !== null && body.delaySec !== "") {
            const seconds = Number(body.delaySec);
            if (!Number.isFinite(seconds) || seconds < 0) {
                res.status(400).json({ ok: false, error: "delaySec 必須是非負數（秒）" });
                return;
            }
            patch.runAt = Date.now() + seconds * 1000;
        }
        else if (body.sendAt !== undefined && body.sendAt !== null && body.sendAt !== "") {
            const resolved = resolveRunAt({ sendAt: body.sendAt });
            if (resolved.error || resolved.runAt === undefined) {
                res.status(400).json({ ok: false, error: resolved.error ?? "sendAt 無效" });
                return;
            }
            patch.runAt = resolved.runAt;
        }
        if (body.repeat !== undefined) {
            const repeatChecked = validateRepeat(body.repeat);
            if ("error" in repeatChecked) {
                res.status(400).json({ ok: false, error: repeatChecked.error });
                return;
            }
            patch.repeat = repeatChecked.repeat || null;
        }
        try {
            const job = line.updateScheduled(id, patch);
            if (!job) {
                res.status(404).json({ ok: false, error: "找不到排程" });
                return;
            }
            res.json({ ok: true, job });
        }
        catch (error) {
            res.status(400).json({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
    app.post("/webhook", ipGuard, rateLimit, verifyWebhookAuth, makeWebhookSender(() => line));
    // Telegram 發送端點：語意與 /webhook 相同，走 Telegram 服務。
    app.post("/webhook/tg", ipGuard, rateLimit, verifyWebhookAuth, makeWebhookSender(() => getService("telegram")));
    // Telegram 接收端點：由 Telegram Bot API 推送 update 進來，驗 X-Telegram-Bot-Api-Secret-Token。
    app.post("/tg/update", rateLimit, (req, res) => {
        const service = getService("telegram");
        if (!service || !config.telegram.enabled || !config.telegram.botToken.trim()) {
            res.status(503).json({ ok: false, error: "Telegram 未啟用" });
            return;
        }
        const expected = config.telegram.secretToken.trim();
        if (expected) {
            const provided = req.header("x-telegram-bot-api-secret-token") ?? "";
            if (!constantTimeEqual(provided, expected)) {
                logger.warn("Telegram update 密鑰不符", { ip: clientIp(req) });
                res.status(403).json({ ok: false });
                return;
            }
        }
        // 先回 200 避免 Telegram 重送；實際處理非同步進行。
        res.json({ ok: true });
        void Promise.resolve(service.handleIncoming?.(req.body)).catch((error: unknown) => {
            logger.error("Telegram update 處理失敗", {
                error: error instanceof Error ? error.message : String(error),
            });
        });
    });
    const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
        const status = typeof err?.status === "number"
            ? err.status
            : typeof err?.statusCode === "number"
                ? err.statusCode
                : 500;
        if (status >= 400 && status < 500) {
            logger.warn("請求錯誤", {
                ip: req.ip,
                path: req.path,
                status,
                error: err instanceof Error ? err.message : String(err),
            });
            const message = err?.type === "entity.parse.failed" ? "JSON 格式錯誤" : "請求格式錯誤";
            res.status(status).json({ ok: false, error: message });
            return;
        }
        logger.error("未處理的錯誤", {
            ip: req.ip,
            path: req.path,
            error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ ok: false, error: "內部錯誤" });
    };
    app.use(errorHandler);
    return app;
}
//# sourceMappingURL=server.js.map