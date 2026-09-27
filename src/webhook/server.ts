import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
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
import { LineService, NotLoggedInError, TargetNotFoundError, type FlexInput, type LocationInput, type SendInput, type StickerInput } from "../line/client.js";
import { isDuplicateIdempotency, markIdempotency, verifyWebhookAuth, type RawBodyRequest } from "../middleware/hmac.js";
import { getMessages, reloadMessages } from "../messages.js";
import { clientIp, ipGuard, isPrivateRequest } from "../middleware/ip.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  changePassword,
  createSession,
  currentUser,
  destroySession,
  hasSession,
  requireSession,
  sessionRemainingMs,
  verifyCredentials,
} from "../middleware/session.js";

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseTargets(value: unknown): string[] {
  const targets: string[] = [];
  if (typeof value === "string") {
    if (value.trim()) targets.push(value.trim());
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim()) targets.push(item.trim());
    }
  }
  return targets;
}

function parseSticker(value: unknown): StickerInput | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const packageId = raw.packageId ?? raw.package_id;
  const stickerId = raw.stickerId ?? raw.sticker_id;
  if (packageId === undefined || stickerId === undefined) return undefined;
  return {
    packageId: String(packageId),
    stickerId: String(stickerId),
    version: raw.version === undefined ? undefined : String(raw.version),
  };
}

function parseLocation(value: unknown): LocationInput | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  return {
    title: typeof raw.title === "string" ? raw.title : "",
    address: typeof raw.address === "string" ? raw.address : "",
    latitude,
    longitude,
  };
}

function parseFlex(value: unknown): FlexInput | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  let contents: unknown = raw.contents ?? raw.json;
  if (typeof contents === "string") {
    try {
      contents = JSON.parse(contents);
    } catch {
      return undefined;
    }
  }
  const record = asRecord(contents);
  if (!record) return undefined;
  return {
    altText: typeof raw.altText === "string" && raw.altText ? raw.altText : "Flex 訊息",
    contents: record,
  };
}

function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}

function parseVars(value: unknown): Record<string, string> {
  const raw = asRecord(value);
  if (!raw) return {};
  const vars: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (item === undefined || item === null) continue;
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
  if (sendAt === undefined || sendAt === null || sendAt === "") return {};

  let runAt: number;
  if (typeof sendAt === "number") {
    runAt = sendAt < 1e12 ? sendAt * 1000 : sendAt;
  } else if (typeof sendAt === "string") {
    const trimmed = sendAt.trim();
    const numeric = Number(trimmed);
    if (trimmed !== "" && Number.isFinite(numeric)) {
      runAt = numeric < 1e12 ? numeric * 1000 : numeric;
    } else {
      const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(trimmed)
        ? trimmed.replace(" ", "T")
        : trimmed;
      runAt = Date.parse(normalized);
    }
  } else {
    return { error: "sendAt 格式錯誤" };
  }

  if (!Number.isFinite(runAt)) return { error: "sendAt 無法解析" };
  if (runAt < Date.now() - 60_000) return { error: "sendAt 不可早於現在" };
  if (runAt > Date.now() + MAX_SCHEDULE_AHEAD_MS) {
    return { error: "sendAt 最遠僅支援 30 天內" };
  }
  return { runAt };
}

function findFlexTemplate(name: string): FlexInput | undefined {
  const tpl = config.flexTemplates.find((item) => item.name === name);
  if (!tpl) return undefined;
  try {
    const contents = asRecord(JSON.parse(tpl.contents));
    if (!contents) return undefined;
    return { altText: tpl.altText || "Flex 訊息", contents };
  } catch {
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
    if (!template) return { error: `找不到模板：${templateName}` };
    if (!text) text = template.text;
  }
  if (text && Object.keys(vars).length > 0) text = renderTemplate(text, vars);

  let flex = parseFlex(msg.flex);
  const flexName = typeof msg.flexTemplate === "string" ? msg.flexTemplate.trim() : "";
  if (!flex && flexName) {
    flex = findFlexTemplate(flexName);
    if (!flex) return { error: `找不到 Flex 樣板：${flexName}` };
    if (Object.keys(vars).length > 0) {
      flex = {
        altText: renderTemplate(flex.altText, vars),
        contents: JSON.parse(renderTemplate(JSON.stringify(flex.contents), vars)) as Record<
          string,
          unknown
        >,
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

function resolveInputs(
  body: Record<string, unknown>,
  targets: string[],
): SendInput[] | { error: string } {
  const messagesRaw = body.messages;
  if (Array.isArray(messagesRaw) && messagesRaw.length > 0) {
    const perMessage: Array<{ to?: string; parsed: ParsedMessage }> = [];
    for (const raw of messagesRaw) {
      const result = parseMessage(raw);
      if ("error" in result) return result;
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
  if ("error" in result) return result;
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
  .user-dock { margin-top: auto; padding-top: 14px; position: relative; }
  .user-countdown { font-size: 12px; color: #94a3b8; font-variant-numeric: tabular-nums; letter-spacing: .06em; margin-bottom: 6px; }
  .user-avatar { width: 42px; height: 42px; padding: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 17px; font-weight: 800; text-transform: uppercase; color: #0b1020; background: linear-gradient(135deg, #22d3ee, #f472b6); border: none; box-shadow: 0 0 18px rgba(34,211,238,.55); }
  .user-avatar:hover { transform: scale(1.08); box-shadow: 0 0 24px rgba(244,114,182,.7); }
  .user-menu { position: absolute; bottom: 60px; left: 0; min-width: 150px; display: flex; flex-direction: column; gap: 4px; padding: 6px; z-index: 20; background: rgba(15,10,40,.96); border: 1px solid rgba(34,211,238,.35); border-radius: 14px; box-shadow: 0 12px 28px rgba(0,0,0,.5), 0 0 20px rgba(34,211,238,.25); backdrop-filter: blur(10px); }
  .user-menu[hidden] { display: none; }
  .user-menu button { text-align: left; width: 100%; padding: 9px 12px; border: none; border-radius: 9px; background: transparent; color: #e2e8f0; font-weight: 600; }
  .user-menu button:hover { background: linear-gradient(90deg, rgba(34,211,238,.25), rgba(244,114,182,.25)); box-shadow: none; transform: none; }
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
  .fn-panel { display: none; }
  .fn-panel.active { display: block; }
  @media (max-width: 820px) {
    .shell { grid-template-columns: 1fr; }
    .sidebar { position: static; }
    nav { flex-direction: row; flex-wrap: wrap; }
    nav .logout { width: auto; margin-top: 0; margin-left: auto; }
    .fn-list { flex-direction: row; flex-wrap: wrap; }
    .fn-card { width: auto; }
    .side-section { width: 100%; }
    .stat-cards { grid-template-columns: repeat(2, 1fr); }
    .dash-grid { grid-template-columns: 1fr; }
  }
  .login-center { min-height: 82vh; display: flex; align-items: center; justify-content: center; }
  .login-card { max-width: 380px; width: 100%; text-align: center; }
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
  options: { showNav?: boolean; sidebar?: string; showTitle?: boolean } = {},
): string {
  const showNav = options.showNav ?? true;
  const showTitle = options.showTitle ?? true;
  const nav = [
    ["/dashboard", "儀表板", "dashboard"],
    ["/status", "狀態", "status"],
    ["/console", "功能", "console"],
    ["/settings", "設定", "settings"],
    ["/messages", "訊息", "messages"],
    ["/readme", "ReadMe", "readme"],
  ]
    .map(
      ([href, label, key]) =>
        `<a href="${href}" class="${key === active ? "active" : ""}">${label}</a>`,
    )
    .join("");

  const username = currentUser();
  const initial = (username.trim()[0] || "?").toUpperCase();
  const esc = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const userDock = showNav
    ? `<div class="user-dock">
<div class="user-countdown" id="user-countdown" title="閒置自動登出倒數">05:00</div>
<button type="button" class="user-avatar" id="user-avatar" title="${esc(username)}">${esc(initial)}</button>
<div class="user-menu" id="user-menu" hidden>
  <button type="button" id="menu-password">變更密碼</button>
  <button type="button" id="menu-logout">登出</button>
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

  const modal = showNav
    ? `<div class="modal-backdrop" id="password-modal" hidden>
<div class="glass modal">
  <h2 style="margin-top:0">變更密碼</h2>
  <div class="field"><label>目前密碼</label><input id="pw-current" type="password" autocomplete="current-password"></div>
  <div class="field"><label>新密碼</label><input id="pw-new" type="password" autocomplete="new-password"></div>
  <div class="field"><label>確認新密碼</label><input id="pw-confirm" type="password" autocomplete="new-password"></div>
  <p id="pw-msg" class="msg"></p>
  <div class="actions"><button type="button" id="pw-cancel">取消</button><button type="button" id="pw-save">儲存</button></div>
</div>
</div>`
    : "";

  return `<!doctype html>
<html lang="zh-Hant">
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
${showTitle ? `<h1 class="neon-text">${title}</h1>` : ""}
${body}
</main>
</div>
${modal}
<script>
${script}${showNav ? USER_SCRIPT : ""}
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
    cell.textContent = "尚無資料";
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
          return res.ok ? res.json() : null;
        })
        .then(function (data) {
          if (data && typeof data.remainingMs === "number") setRemaining(data.remainingMs);
        })
        .catch(function () {});
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

function renderStatusHtml(): string {
  const body = `
<div><span id="badge" class="badge">-</span></div>
<div id="qrbox" style="display:none">
  <p><b>請用手機 LINE 的掃描功能掃描：</b></p>
  <img id="qrimg" alt="LINE QR" style="width:280px;height:280px;background:#fff;border:1px solid #ddd;padding:8px">
  <div id="qrlink" class="msg"></div>
</div>
<div id="verify"></div>
<h2>摘要</h2>
<div class="glass glass-hover"><table class="kv"><tbody id="summary"></tbody></table></div>
`;

  const script = `
  ${HELPERS}
  var qrBox = $("qrbox");
  var qrImg = $("qrimg");
  var qrLink = $("qrlink");
  var lastQr = "";

  function render(data) {
    var s = data.state;
    var badge = $("badge");
    badge.textContent = s.status;
    badge.className = "badge " + (s.status === "已登入" ? "ok" : (s.status === "待驗證" || s.status === "需人工" ? "bad" : "warn"));

    var verify = $("verify");
    verify.replaceChildren();
    if (s.qrUrl) {
      qrBox.style.display = "block";
      if (s.qrUrl !== lastQr) {
        lastQr = s.qrUrl;
        qrImg.src = "/status/qr?t=" + Date.now();
      }
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

    var summary = [
      ["登入狀態", s.status],
      ["帳號名稱", s.profileName || "-"],
      ["我的 MID", s.myMid || "-"],
      ["好友數", String(s.friendCount == null ? 0 : s.friendCount)],
      ["群組數", String(s.chatCount == null ? 0 : s.chatCount)],
      ["佇列等待", String(data.queue.pending) + (data.queue.running ? "（發送中）" : "")],
      ["最後登入", s.lastLoginAt || "-"],
      ["最後發送時間", s.lastSendAt || "-"],
      ["最後發送對象", s.lastSendTo || "-"],
      ["最後錯誤", s.lastError || "-"],
      ["啟動時間", s.startedAt || "-"]
    ];
    $("summary").replaceChildren.apply($("summary"), summary.map(function (pair) {
      var th = document.createElement("th");
      th.textContent = pair[0];
      return tr(th, td(pair[1]));
    }));
  }

  function refresh() {
    fetch("/status.json", { cache: "no-store" })
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
  return page("狀態", "status", body, script);
}

function renderDashboardHtml(): string {
  const body = `
<div><span id="badge" class="badge">-</span></div>
<div id="qrbox" style="display:none">
  <p><b>請用手機 LINE 的掃描功能掃描：</b></p>
  <img id="qrimg" alt="LINE QR" style="width:280px;height:280px;background:#fff;border:1px solid #ddd;padding:8px">
  <div id="qrlink" class="msg"></div>
</div>
<div id="verify"></div>

<h2>發送統計</h2>
<div class="glass">
  <div class="stat-cards">
    <div class="stat-card"><div class="stat-num" id="stat-total">0</div><div class="stat-label">總發送</div></div>
    <div class="stat-card"><div class="stat-num" id="stat-ok">0</div><div class="stat-label">成功</div></div>
    <div class="stat-card"><div class="stat-num" id="stat-fail">0</div><div class="stat-label">失敗</div></div>
    <div class="stat-card"><div class="stat-num" id="stat-rate">0%</div><div class="stat-label">成功率</div></div>
  </div>
  <div class="chart" id="chart"></div>
  <div class="msg" id="stat-types" style="margin-top:10px"></div>
</div>

<div class="dash-grid">
  <div class="glass">
    <h2 style="margin-top:0">狀態摘要</h2>
    <table class="kv"><tbody id="summary"></tbody></table>
  </div>
  <div class="glass">
    <h2 style="margin-top:0">最近發送 / 紀錄</h2>
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

  function renderSummary(s, queue) {
    var summary = [
      ["登入狀態", s.status],
      ["帳號名稱", s.profileName || "-"],
      ["我的 MID", s.myMid || "-"],
      ["好友數", String(s.friendCount == null ? 0 : s.friendCount)],
      ["群組數", String(s.chatCount == null ? 0 : s.chatCount)],
      ["佇列等待", String(queue.pending) + (queue.running ? "（發送中）" : "")],
      ["最後登入", s.lastLoginAt || "-"],
      ["最後發送時間", s.lastSendAt || "-"],
      ["最後發送對象", s.lastSendTo || "-"],
      ["最後錯誤", s.lastError || "-"],
      ["啟動時間", s.startedAt || "-"]
    ];
    $("summary").replaceChildren.apply($("summary"), summary.map(function (pair) {
      var th = document.createElement("th");
      th.textContent = pair[0];
      return tr(th, td(pair[1]));
    }));
  }

  function renderChart(days) {
    var max = 1;
    days.forEach(function (d) { if (d.total > max) max = d.total; });
    $("chart").replaceChildren.apply($("chart"), days.map(function (d) {
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

    renderSummary(s, data.queue);

    var stats = data.stats || { total: 0, ok: 0, fail: 0, successRate: 0, byType: {}, days: [] };
    $("stat-total").textContent = String(stats.total);
    $("stat-ok").textContent = String(stats.ok);
    $("stat-fail").textContent = String(stats.fail);
    $("stat-rate").textContent = stats.successRate + "%";
    renderChart(stats.days || []);
    var types = Object.keys(stats.byType || {}).map(function (k) { return k + "：" + stats.byType[k]; });
    $("stat-types").textContent = types.length ? "類型 " + types.join("、") : "尚無發送紀錄";

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

  function refresh() {
    fetch("/dashboard.json", { cache: "no-store" })
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
  return page("儀表板", "dashboard", body, script);
}

function renderSettingsHtml(): string {
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

  const body = `
<p class="msg">設定儲存於 <code>settings.json</code>，修改後立即生效（LINE 裝置名稱需重新登入才生效）；點左側卡片切換設定項目。</p>

<form id="settings-form" class="fn-panel active">
  <fieldset class="fn-panel active" data-fn="security">
    <legend>安全 / 來源</legend>
    <div class="field"><label>允許的來源 IP</label><textarea id="allowedIps" placeholder="逗號或換行分隔，留空 = 不限制"></textarea></div>
    <div class="field"><label>HMAC 簽章密鑰</label><span style="display:flex;gap:8px"><input id="hmacSecret" type="text" style="flex:1"><button type="button" id="hmac-generate">隨機產生</button></span><div class="hint">留空 = 不驗證簽章</div></div>
    <div class="field"><label>時間戳記容許誤差（秒）</label><input id="hmacMaxSkewSec" type="number" min="0"></div>
    <div class="field"><label>Webhook URL Token</label><span style="display:flex;gap:8px"><input id="webhookToken" type="text" style="flex:1"><button type="button" id="token-generate">隨機產生</button></span><div class="hint">供無法簽章的來源：網址帶 <code>?token=...</code> 或標頭 <code>X-Webhook-Token</code>；與 HMAC 並存時任一通過即可</div></div>
    <div class="field"><label>API Token（Bearer）</label><span style="display:flex;gap:8px"><input id="apiToken" type="text" style="flex:1"><button type="button" id="api-token-generate">隨機產生</button></span><div class="hint">呼叫 webhook 時帶 <code>Authorization: Bearer &lt;token&gt;</code>；與 HMAC / URL Token 並存時任一通過即可</div></div>
    <div class="field"><label>多組 API Token</label><div id="apiTokens"></div><div class="hint" style="grid-column:1">具名 token，可各自撤銷；與上方 API Token、HMAC、URL Token 任一通過即可</div></div>
    <div class="actions" style="margin:0 0 10px"><button type="button" id="api-token-add">新增 API Token</button></div>
    <div class="field"><label>僅限私人 IP 存取管理頁面</label><input id="adminPrivateOnly" type="checkbox"><div class="hint">狀態頁 / 儀表板 / 功能頁 / 設定頁 / 訊息 / ReadMe / 登入頁僅允許內網（10.x / 172.16–31.x / 192.168.x / 127.x）存取；webhook 不受影響</div></div>
    <div class="field"><label>速率限制視窗（ms）</label><input id="rateLimit-windowMs" type="number" min="1"></div>
    <div class="field"><label>每 IP 最大請求數</label><input id="rateLimit-max" type="number" min="1"></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="line">
    <legend>LINE 登入</legend>
    <div class="field"><label>裝置類型</label><select id="line-device">${deviceOptions}</select></div>
    <div class="field"><label>顯示名稱（systemName）</label><input id="line-deviceName" type="text"></div>
    <div class="field"><label>機型（modelName）</label><input id="line-modelName" type="text"><div class="hint">顯示名稱需重新登入才生效</div></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="send">
    <legend>發送 / 重試</legend>
    <div class="field"><label>最大重試次數</label><input id="send-maxRetries" type="number" min="0"></div>
    <div class="field"><label>重試退避基準（ms）</label><input id="send-retryBaseMs" type="number" min="1"></div>
    <div class="field"><label>最小發送間隔（ms）</label><input id="send-minIntervalMs" type="number" min="0"></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="monitor">
    <legend>監控 / Log</legend>
    <div class="field"><label>健康檢查間隔（秒）</label><input id="healthCheckIntervalSec" type="number" min="1"></div>
    <div class="field"><label>記憶體保留紀錄筆數</label><input id="logLimit" type="number" min="1"></div>
    <div class="field"><label>Log 輪替大小（bytes）</label><input id="logMaxBytes" type="number" min="1"></div>
    <div class="field"><label>Log 保留檔數</label><input id="logMaxFiles" type="number" min="1"></div>
    <div class="field"><label>持久化收到的訊息</label><input id="messagesPersist" type="checkbox"><div class="hint">開啟後將收到的訊息寫入檔案（路徑：<code>${config.messagesPath}</code>，於 .env 設定）</div></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="targets-config">
    <legend>目標對照（TARGETS）</legend>
    <div class="field"><label>名稱=mid</label><textarea id="targets" placeholder="每行一筆，例如：小明=u1234567890abcdef"></textarea></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="templates">
    <legend>訊息模板（Templates）</legend>
    <div class="hint" style="margin-bottom:8px">webhook 帶 <code>template</code> 名稱與 <code>vars</code> 變數即可套用；模板內用 <code>{{key}}</code> 取用變數，未提供的變數會原樣保留。</div>
    <div id="templates"></div>
    <div class="actions"><button type="button" id="template-add">新增模板</button></div>
    <div class="hint" style="margin:14px 0 8px">Flex 樣板：webhook 帶 <code>flexTemplate</code> 名稱即可套用；<code>contents</code> 為 Flex 容器 JSON（可用 <code>{{key}}</code> 變數）。</div>
    <div id="flexTemplates"></div>
    <div class="actions"><button type="button" id="flex-template-add">新增 Flex 樣板</button></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="autoReply">
    <legend>關鍵字自動回覆</legend>
    <div class="field"><label>啟用自動回覆</label><input id="autoReply-enabled" type="checkbox"><div class="hint">依規則比對收到的訊息並回覆（可回文字與／或圖片、檔案）</div></div>
    <div class="field"><label>回覆冷卻（秒）</label><input id="autoReply-cooldownSec" type="number" min="0"><div class="hint">同一個聊天於此時間內只回覆一次，避免被刷</div></div>
    <div id="rules"></div>
    <div class="actions"><button type="button" id="rule-add">新增規則</button></div>
    <div class="hint">關鍵字可用 <code>|</code> 分隔多組；比對方式：完全相符 / 包含 / 正則（regex）。回覆文字與檔名可用 <code>{{name}}</code>（對方名稱）、<code>{{keyword}}</code>、<code>{{text}}</code>。</div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="forward">
    <legend>訊息轉發規則</legend>
    <div class="hint" style="margin-bottom:8px">收到訊息且符合條件時，自動轉發到指定的好友 / 群組（填入名稱或 mid）。</div>
    <div id="forwardRules"></div>
    <div class="actions"><button type="button" id="forward-add">新增轉發規則</button></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="commands">
    <legend>LINE 指令</legend>
    <div class="field"><label>啟用指令</label><input id="commands-enabled" type="checkbox"><div class="hint">允許在 LINE 對本帳號傳送指令（例如 <code>!help</code>）</div></div>
    <div class="field"><label>指令前綴</label><input id="commands-prefix" type="text" placeholder="!"><div class="hint">預設 <code>!</code></div></div>
    <div class="field"><label>允許來源</label><textarea id="commands-allowFrom" placeholder="留空 = 所有人；每行一個 mid 或 chat mid"></textarea><div class="hint">可用 <code>!id</code> 取得自己的 mid；建議限制來源避免被濫用</div></div>
    <div class="hint">可用指令：<code>help</code>、<code>status</code>、<code>id</code>、<code>send &lt;對象&gt; &lt;訊息&gt;</code></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="smtp">
    <legend>Email 通知（SMTP）</legend>
    <div class="field"><label>SMTP Host</label><input id="smtp-host" type="text"></div>
    <div class="field"><label>SMTP Port</label><input id="smtp-port" type="number" min="1"></div>
    <div class="field"><label>SMTP Secure</label><input id="smtp-secure" type="checkbox"></div>
    <div class="field"><label>SMTP User</label><input id="smtp-user" type="text"></div>
    <div class="field"><label>SMTP Password</label><input id="smtp-pass" type="password"></div>
    <div class="field"><label>寄件者（From）</label><input id="smtp-from" type="text"></div>
    <div class="field"><label>收件者（To）</label><input id="smtp-to" type="text"></div>
  </fieldset>

  <fieldset class="fn-panel" data-fn="backup">
    <legend>設定匯出 / 匯入</legend>
    <div class="hint" style="margin-bottom:8px">匯出為 JSON 檔（含密鑰，請妥善保管）；匯入會覆蓋目前設定。</div>
    <div class="actions">
      <button type="button" id="settings-export">匯出設定</button>
      <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">匯入設定<input id="settings-import-file" type="file" accept="application/json,.json" style="display:none"></label>
    </div>
  </fieldset>

  <div class="actions">
    <button type="submit">儲存設定</button>
    <span id="settings-msg" class="msg"></span>
  </div>
</form>
`;

  const script = `
  ${HELPERS}
  ${SESSION_SCRIPT}
  var CONFIG_SECTIONS = ["security", "line", "send", "monitor", "targets-config", "templates", "autoReply", "forward", "commands", "smtp", "backup"];

  function addRuleRow(rule) {
    rule = rule || {};
    var row = document.createElement("div");
    row.className = "rule-row";
    row.style.cssText = "border:1px solid rgba(34,211,238,.25);border-radius:12px;padding:10px 14px;margin-bottom:10px;background:rgba(0,0,0,.2)";

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

    var keyword = textInput("r-keyword", rule.keyword, "例如：報價單 | 價目");
    var match = document.createElement("select");
    match.className = "r-match";
    [["exact", "完全相符"], ["contains", "包含"], ["regex", "正則"]].forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt[0];
      o.textContent = opt[1];
      if ((rule.match || "exact") === opt[0]) o.selected = true;
      match.appendChild(o);
    });
    var text = textInput("r-text", rule.text, "回覆文字（可留空，支援 {{name}}）");
    var image = textInput("r-image", rule.image, "回覆圖片（URL 或路徑，選填）");
    var filePath = textInput("r-filePath", rule.filePath, "檔案路徑，例如 C:\\\\quotes\\\\quote.pdf");
    var filename = textInput("r-filename", rule.filename, "顯示檔名（選填）");
    var enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "r-enabled";
    enabled.checked = rule.enabled !== false;

    row.append(field("關鍵字（| 分隔）", keyword));
    row.append(field("比對方式", match));
    row.append(field("回覆文字", text));
    row.append(field("回覆圖片", image));
    row.append(field("檔案路徑", filePath));
    row.append(field("檔名", filename));
    row.append(field("啟用", enabled));

    var actions = document.createElement("div");
    actions.className = "actions";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "刪除規則";
    remove.addEventListener("click", function () { row.remove(); });
    actions.appendChild(remove);
    row.appendChild(actions);

    $("rules").appendChild(row);
  }

  function collectRules() {
    var out = [];
    var rows = $("rules").querySelectorAll(".rule-row");
    Array.prototype.forEach.call(rows, function (row) {
      out.push({
        keyword: row.querySelector(".r-keyword").value,
        match: row.querySelector(".r-match").value,
        text: row.querySelector(".r-text").value,
        image: row.querySelector(".r-image").value,
        filePath: row.querySelector(".r-filePath").value,
        filename: row.querySelector(".r-filename").value,
        enabled: row.querySelector(".r-enabled").checked
      });
    });
    return out;
  }

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
    [["contains", "包含"], ["regex", "正則"], ["all", "全部"]].forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt[0];
      o.textContent = opt[1];
      if ((rule.match || "contains") === opt[0]) o.selected = true;
      match.appendChild(o);
    });
    var keyword = textInput("f-keyword", rule.keyword, "關鍵字（| 分隔）");
    var source = textInput("f-source", rule.source, "來源聊天（留空 = 全部）");
    var target = textInput("f-target", rule.target, "轉發對象（名稱或 mid）");
    var prefix = textInput("f-prefix", rule.prefix, "前綴文字（選填）");
    var includeSender = document.createElement("input");
    includeSender.type = "checkbox";
    includeSender.className = "f-includeSender";
    includeSender.checked = !!rule.includeSender;
    var enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "f-enabled";
    enabled.checked = rule.enabled !== false;

    row.append(field("比對方式", match));
    row.append(field("關鍵字", keyword));
    row.append(field("來源", source));
    row.append(field("轉發對象", target));
    row.append(field("前綴", prefix));
    row.append(field("附上來源名稱", includeSender));
    row.append(field("啟用", enabled));

    var actions = document.createElement("div");
    actions.className = "actions";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "刪除規則";
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
    var row = document.createElement("div");
    row.className = "api-token-row";
    row.style.cssText = "display:flex;gap:8px;margin-bottom:8px;grid-column:2";
    var name = document.createElement("input");
    name.type = "text";
    name.className = "at-name";
    name.value = item.name || "";
    name.placeholder = "名稱";
    name.style.flex = "0 0 120px";
    var token = document.createElement("input");
    token.type = "text";
    token.className = "at-token";
    token.value = item.token || "";
    token.placeholder = "token";
    token.style.flex = "1";
    var gen = document.createElement("button");
    gen.type = "button";
    gen.textContent = "產生";
    gen.addEventListener("click", function () { token.value = randomHex(32); });
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "刪除";
    remove.addEventListener("click", function () { row.remove(); });
    row.append(name, token, gen, remove);
    $("apiTokens").appendChild(row);
  }

  function collectApiTokens() {
    var out = [];
    var rows = $("apiTokens").querySelectorAll(".api-token-row");
    Array.prototype.forEach.call(rows, function (row) {
      out.push({
        name: row.querySelector(".at-name").value.trim(),
        token: row.querySelector(".at-token").value.trim()
      });
    });
    return out.filter(function (item) { return item.token; });
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
    name.placeholder = "例如：每日報價";

    var text = document.createElement("textarea");
    text.className = "t-text";
    text.value = tpl.text || "";
    text.placeholder = "可用 {{name}} 之類的變數";

    row.append(field("名稱", name));
    row.append(field("內容", text));

    var actions = document.createElement("div");
    actions.className = "actions";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "刪除模板";
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
    name.placeholder = "例如：公告卡片";

    var alt = document.createElement("input");
    alt.type = "text";
    alt.className = "ft-alt";
    alt.value = tpl.altText || "";
    alt.placeholder = "替代文字（altText）";

    var contents = document.createElement("textarea");
    contents.className = "ft-contents";
    contents.value = tpl.contents || "";
    contents.placeholder = '{"type":"bubble","body":{...}}';

    row.append(field("名稱", name));
    row.append(field("altText", alt));
    row.append(field("Flex JSON", contents));

    var actions = document.createElement("div");
    actions.className = "actions";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "刪除樣板";
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
    $("hmacMaxSkewSec").value = s.hmacMaxSkewSec;
    $("webhookToken").value = s.webhookToken || "";
    $("apiToken").value = s.apiToken || "";
    $("adminPrivateOnly").checked = !!s.adminPrivateOnly;
    $("rateLimit-windowMs").value = s.rateLimit.windowMs;
    $("rateLimit-max").value = s.rateLimit.max;
    $("line-device").value = s.line.device;
    $("line-deviceName").value = s.line.deviceName || "";
    $("line-modelName").value = s.line.modelName || "";
    $("send-maxRetries").value = s.send.maxRetries;
    $("send-retryBaseMs").value = s.send.retryBaseMs;
    $("send-minIntervalMs").value = s.send.minIntervalMs;
    $("healthCheckIntervalSec").value = s.healthCheckIntervalSec;
    $("logLimit").value = s.logLimit;
    $("logMaxBytes").value = s.logMaxBytes;
    $("logMaxFiles").value = s.logMaxFiles;
    $("messagesPersist").checked = !!s.messagesPersist;
    $("targets").value = Object.keys(s.targets || {}).map(function (k) { return k + "=" + s.targets[k]; }).join("\\n");
    $("smtp-host").value = s.smtp.host || "";
    $("smtp-port").value = s.smtp.port;
    $("smtp-secure").checked = !!s.smtp.secure;
    $("smtp-user").value = s.smtp.user || "";
    $("smtp-pass").value = s.smtp.pass || "";
    $("smtp-from").value = s.smtp.from || "";
    $("smtp-to").value = s.smtp.to || "";
    $("autoReply-enabled").checked = !!(s.autoReply && s.autoReply.enabled);
    $("autoReply-cooldownSec").value = (s.autoReply && s.autoReply.cooldownSec) || 0;
    $("rules").replaceChildren();
    ((s.autoReply && s.autoReply.rules) || []).forEach(addRuleRow);
    $("templates").replaceChildren();
    (s.templates || []).forEach(addTemplateRow);
    $("flexTemplates").replaceChildren();
    (s.flexTemplates || []).forEach(addFlexTemplateRow);
    $("apiTokens").replaceChildren();
    (s.apiTokens || []).forEach(addApiTokenRow);
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
    return {
      allowedIps: $("allowedIps").value.split(/[\\n,]/).map(function (x) { return x.trim(); }).filter(Boolean),
      hmacSecret: $("hmacSecret").value,
      hmacMaxSkewSec: Number($("hmacMaxSkewSec").value),
      webhookToken: $("webhookToken").value,
      apiToken: $("apiToken").value,
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
      send: {
        maxRetries: Number($("send-maxRetries").value),
        retryBaseMs: Number($("send-retryBaseMs").value),
        minIntervalMs: Number($("send-minIntervalMs").value)
      },
      rateLimit: {
        windowMs: Number($("rateLimit-windowMs").value),
        max: Number($("rateLimit-max").value)
      },
      line: {
        device: $("line-device").value,
        deviceName: $("line-deviceName").value,
        modelName: $("line-modelName").value
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
      autoReply: {
        enabled: $("autoReply-enabled").checked,
        cooldownSec: Number($("autoReply-cooldownSec").value),
        rules: collectRules()
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

  $("rule-add").addEventListener("click", function () {
    addRuleRow({});
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
<div class="side-section">設定</div>
<div class="fn-list">
  <button type="button" class="fn-card setting active" data-fn="security">安全 / 來源</button>
  <button type="button" class="fn-card setting" data-fn="line">LINE 登入</button>
  <button type="button" class="fn-card setting" data-fn="send">發送 / 重試</button>
  <button type="button" class="fn-card setting" data-fn="monitor">監控 / Log</button>
  <button type="button" class="fn-card setting" data-fn="targets-config">目標對照</button>
  <button type="button" class="fn-card setting" data-fn="templates">訊息模板</button>
  <button type="button" class="fn-card setting" data-fn="autoReply">關鍵字自動回覆</button>
  <button type="button" class="fn-card setting" data-fn="forward">訊息轉發規則</button>
  <button type="button" class="fn-card setting" data-fn="commands">LINE 指令</button>
  <button type="button" class="fn-card setting" data-fn="smtp">Email 通知</button>
  <button type="button" class="fn-card setting" data-fn="backup">匯出 / 匯入</button>
</div>`;

  return page("設定", "settings", body, script, { sidebar });
}

function renderConsoleHtml(): string {
  const body = `
<div class="fn-panel active" data-fn="test">
<h2 style="margin-top:0">測試發送</h2>
<div class="glass glass-hover">
<form id="test-form">
  <div class="field"><label>對象</label><input id="test-to" placeholder="好友名稱或 mid" required></div>
  <div class="field"><label>文字</label><input id="test-text" placeholder="訊息內容（可留空）"></div>
  <div class="field"><label>檔案路徑</label><input id="test-file" placeholder="伺服器上的檔案路徑，例如 /opt/app/quote.pdf"></div>
  <div class="field"><label>圖片（URL 或路徑）</label><input id="test-image" placeholder="https://... 或 /opt/app/a.jpg"></div>
  <div class="field"><label>影片（URL 或路徑）</label><input id="test-video" placeholder="https://... 或 /opt/app/a.mp4"></div>
  <div class="field"><label>語音（URL 或路徑）</label><input id="test-audio" placeholder="https://... 或 /opt/app/a.m4a"></div>
  <div class="field"><label>顯示檔名</label><input id="test-filename" placeholder="選填"></div>
  <details>
    <summary>進階（貼圖 / 位置 / Flex / 延遲）</summary>
    <div class="field"><label>貼圖 packageId</label><input id="test-sticker-pkg" placeholder="例如 446"></div>
    <div class="field"><label>貼圖 stickerId</label><input id="test-sticker-id" placeholder="例如 1988"></div>
    <div class="field"><label>位置標題</label><input id="test-loc-title" placeholder="選填"></div>
    <div class="field"><label>位置地址</label><input id="test-loc-address" placeholder="選填"></div>
    <div class="field"><label>緯度 / 經度</label><span style="display:flex;gap:8px"><input id="test-loc-lat" placeholder="25.033" style="flex:1"><input id="test-loc-lng" placeholder="121.565" style="flex:1"></span></div>
    <div class="field"><label>Flex altText</label><input id="test-flex-alt" placeholder="選填，預設「Flex 訊息」"></div>
    <div class="field"><label>Flex JSON</label><textarea id="test-flex-json" placeholder='{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"Hi"}]}}'></textarea></div>
    <div class="field"><label>延遲發送</label><span style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><input id="test-delay" type="text" placeholder="秒數（例如 60）或 2026-01-01 09:00:00" style="flex:1;min-width:200px"><input id="test-datetime" type="datetime-local" style="width:auto"><button type="button" id="test-datetime-now">現在+1分</button></span><div class="hint">可填「秒數」或「年月日 時:分:秒」；也可用日曆選時間（會帶入左欄）。留空 = 立即發送，可在「排程中的訊息」取消</div></div>
  </details>
  <div class="field"><label>插入媒體</label><span style="display:flex;gap:8px;flex-wrap:wrap"><input id="test-upload" type="file" style="flex:1"><button type="button" id="test-upload-btn">上傳並填入</button><span id="test-upload-msg" class="msg"></span></span><div class="hint">上傳後會填入「圖片（URL 或路徑）」欄位；影片 / 語音請改填對應欄位</div></div>
  <div class="actions"><button type="submit">發送</button><span id="test-msg" class="msg"></span></div>
</form>
</div>
</div>

<div class="fn-panel" data-fn="targets-list">
<h2 style="margin-top:0">目標清單</h2>
<div class="glass">
<details id="targets-details" open>
  <summary>清單（<span id="target-count">0</span>）</summary>
  <div style="margin:8px 0">
    <input id="target-search" placeholder="搜尋名稱或 MID" style="width:280px">
    <span id="target-msg" class="msg"></span>
  </div>
  <table class="targets-table"><thead><tr><th>名稱</th><th>MID</th><th class="th-actions" style="width:180px">操作</th></tr></thead><tbody id="targets"></tbody></table>
</details>
</div>
</div>

<div class="fn-panel" data-fn="logs">
<h2 style="margin-top:0">最近紀錄</h2>
<div class="glass">
<details open>
  <summary>清單</summary>
  <table><thead><tr><th>時間</th><th>等級</th><th>訊息</th><th>內容</th></tr></thead><tbody id="logs"></tbody></table>
</details>
</div>
</div>

<div class="fn-panel" data-fn="scheduled">
<h2 style="margin-top:0">排程中的訊息</h2>
<div class="glass">
<details open>
  <summary>清單（<span id="scheduled-count">0</span>）</summary>
  <table><thead><tr><th>時間</th><th>對象</th><th>內容</th><th>重複</th><th style="width:190px">操作</th></tr></thead><tbody id="scheduled"></tbody></table>
</details>
</div>
</div>
`;

  const script = `
  ${HELPERS}
  ${SESSION_SCRIPT}
  var allTargets = [];

  function renderTargets() {
    var query = $("target-search").value.trim().toLowerCase();
    var list = allTargets.filter(function (t) {
      if (!query) return true;
      return t.name.toLowerCase().indexOf(query) !== -1 || t.mid.toLowerCase().indexOf(query) !== -1;
    });
    var body = $("targets");
    if (list.length === 0) {
      body.replaceChildren(emptyRow(3));
      return;
    }
    body.replaceChildren.apply(body, list.map(function (t) {
      var copyBtn = document.createElement("button");
      copyBtn.textContent = "複製對應";
      copyBtn.addEventListener("click", function () {
        var text = t.name + "=" + t.mid;
        copyText(text).then(function (ok) {
          $("target-msg").textContent = ok ? "已複製：" + t.name : "無法自動複製，請手動選取：" + text;
        });
      });
      var testBtn = document.createElement("button");
      testBtn.textContent = "測試";
      testBtn.addEventListener("click", function () {
        $("test-to").value = t.name;
        $("test-to").focus();
        $("target-msg").textContent = "已帶入測試對象：" + t.name;
      });
      var actions = document.createElement("td");
      actions.className = "actions-cell";
      actions.append(copyBtn, testBtn);
      return tr(td(t.name), td(t.mid, "mono"), actions);
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
      cancel.textContent = "取消";
      cancel.addEventListener("click", function () {
        post("settings/scheduled/cancel", { id: j.id }).then(function () { refreshData(); });
      });
      var edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "改變時間";
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
    fetch("/status.json", { cache: "no-store" })
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
  $("test-datetime-now").addEventListener("click", function () {
    var d = new Date(Date.now() + 60000);
    d.setSeconds(0, 0);
    $("test-datetime").value = toLocalInput(d);
    setDelayFromPicker();
  });

  $("test-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var payload = {
      to: $("test-to").value.trim(),
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

  setupCards([], "test");
  refreshData();
  setInterval(refreshData, 10000);
`;

  const sidebar = `
<div class="side-section">功能</div>
<div class="fn-list">
  <button type="button" class="fn-card active" data-fn="test">測試發送</button>
  <button type="button" class="fn-card" data-fn="targets-list">目標清單</button>
  <button type="button" class="fn-card" data-fn="logs">最近紀錄</button>
  <button type="button" class="fn-card" data-fn="scheduled">排程中的訊息</button>
</div>
<div class="side-section">操作</div>
<div class="fn-list">
  <button type="button" class="fn-card" id="btn-relogin">Line重新登入</button>
  <button type="button" class="fn-card" id="btn-refresh">重新整理聯絡人</button>
</div>
<p id="action-msg" class="msg" style="align-self:stretch; word-break:break-word; margin:6px 2px 0"></p>`;

  return page("功能", "console", body, script, { sidebar });
}

function renderLoginHtml(): string {
  const body = `
<div class="login-center">
  <div class="glass login-card">
    <h2 class="neon-text">LINE Webhook</h2>
    <div class="sub">請登入以管理</div>
    <form id="login-form">
      <input id="login-user" placeholder="帳號" autocomplete="username" required>
      <input id="login-pass" type="password" placeholder="密碼" autocomplete="current-password" required>
      <button type="submit">登入</button>
      <p id="login-msg" class="msg" style="margin:12px 0 0"></p>
    </form>
  </div>
</div>
`;

  const script = `
  ${HELPERS}
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
  return page("登入", "", body, script, { showNav: false, showTitle: false });
}

let readmeCache: string | null = null;

function readmeHtml(): string {
  if (readmeCache !== null) return readmeCache;
  try {
    const markdown = readFileSync("./README.md", "utf8");
    readmeCache = marked.parse(markdown, { async: false }) as string;
  } catch (error) {
    readmeCache = `<p>無法讀取 README.md：${String(error)}</p>`;
  }
  return readmeCache;
}

function renderReadmeHtml(): string {
  const body = `<div class="glass md">${readmeHtml()}</div>`;
  return page("ReadMe", "readme", body, "");
}

function renderMessagesHtml(): string {
  const body = `
<div class="glass glass-hover">
<h2 style="margin-top:0">收到的訊息</h2>
<table><thead><tr><th>時間</th><th>來源</th><th>對話</th><th>內容</th></tr></thead><tbody id="messages"></tbody></table>
</div>
`;

  const script = `
  ${HELPERS}
  function render(data) {
    var bodyEl = $("messages");
    var list = (data.messages || []).slice().reverse();
    if (list.length === 0) {
      bodyEl.replaceChildren(emptyRow(4));
      return;
    }
    bodyEl.replaceChildren.apply(bodyEl, list.map(function (m) {
      var src = m.fromName ? m.fromName + " (" + m.fromMid + ")" : m.fromMid;
      var chat = m.chatMid;
      if (m.chatType) chat = m.chatType + " " + m.chatMid;
      return tr(td(m.time), td(src), td(chat, "mono"), td(m.text));
    }));
  }

  function refresh() {
    fetch("/messages.json", { cache: "no-store" })
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
  return page("收到的訊息", "messages", body, script);
}

export function createServer(line: LineService): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.use(
    express.json({
      limit: `${config.maxBodyMb}mb`,
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf;
      },
    }),
  );

  app.get("/", (_req, res) => res.redirect("/dashboard"));

  app.get("/health", (_req, res) => {
    const ok = getState().status === "已登入";
    res.json({ status: ok ? "ok" : "bad" });
  });

  app.get("/dashboard", statusAccess, requireSession, (_req, res) => {
    res.type("html").send(renderDashboardHtml());
  });

  app.get("/dashboard.json", statusAccess, requireSession, (_req, res) => {
    res.json({
      state: getState(),
      logs: logger.getRecent(),
      targets: line.listTargets(),
      queue: line.getQueueStats(),
      scheduled: line.listScheduled(),
      stats: getStats(),
      messages: getMessages().slice(-50),
    });
  });

  app.get("/status", statusAccess, requireSession, (_req, res) => {
    res.type("html").send(renderStatusHtml());
  });

  app.get("/status.json", statusAccess, requireSession, (_req, res) => {
    res.json({
      state: getState(),
      logs: logger.getRecent(),
      targets: line.listTargets(),
      queue: line.getQueueStats(),
      scheduled: line.listScheduled(),
    });
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
    } catch {
      res.status(500).send("qr error");
    }
  });

  app.get("/login", statusAccess, (req, res) => {
    if (hasSession(req)) {
      res.redirect("/dashboard");
      return;
    }
    res.type("html").send(renderLoginHtml());
  });

  app.post("/login", statusAccess, (req, res) => {
    const body = req.body as { user?: unknown; pass?: unknown } | undefined;
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

  app.post("/logout", (req, res) => {
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

  // 使用者有操作時續期
  app.post("/settings/touch", statusAccess, (req, res) => {
    const remainingMs = sessionRemainingMs(req, true);
    if (remainingMs !== null) {
      res.json({ ok: true, remainingMs });
      return;
    }
    res.status(401).json({ ok: false, error: "需要登入" });
  });

  app.get("/console", statusAccess, requireSession, (_req, res) => {
    res.type("html").send(renderConsoleHtml());
  });

  app.get("/settings", statusAccess, requireSession, (_req, res) => {
    res.type("html").send(renderSettingsHtml());
  });

  app.get("/readme", statusAccess, requireSession, (_req, res) => {
    res.type("html").send(renderReadmeHtml());
  });

  app.get("/messages", statusAccess, requireSession, (_req, res) => {
    res.type("html").send(renderMessagesHtml());
  });

  app.get("/messages.json", statusAccess, requireSession, (_req, res) => {
    res.json({ messages: getMessages() });
  });

  app.get("/settings.json", statusAccess, requireSession, (_req, res) => {
    res.json(currentSettings());
  });

  app.get("/settings/export", statusAccess, requireSession, (_req, res) => {
    const data = currentSettings();
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="linehook-settings-${Date.now()}.json"`,
    );
    res.type("application/json").send(JSON.stringify(data, null, 2));
  });

  app.post("/settings/import", statusAccess, requireSession, (req, res) => {
    try {
      const body = asRecord(req.body) ?? {};
      const incoming = body.settings ?? req.body;
      const saved = saveSettings(incoming);
      reloadMessages();
      logger.info("已匯入設定", { ip: req.ip });
      res.json({ ok: true, settings: saved });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/settings", statusAccess, requireSession, (req, res) => {
    try {
      const saved = saveSettings(req.body);
      reloadMessages();
      res.json({ ok: true, settings: saved });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/settings/password", statusAccess, requireSession, (req, res) => {
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

  app.post(
    "/settings/upload",
    statusAccess,
    requireSession,
    express.raw({ type: "*/*", limit: `${config.maxBodyMb}mb` }),
    (req, res) => {
      const name =
        decodeURIComponent(String(req.header("x-filename") ?? "upload")).trim() || "upload";
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
        res.json({ ok: true, path: fullPath, filename: safe, bytes: data.length });
      } catch (error) {
        res.status(500).json({ ok: false, error: `儲存失敗：${String(error)}` });
      }
    },
  );

  app.post("/settings/relogin", statusAccess, requireSession, (_req, res) => {
    logger.info("手動觸發重新登入");
    void line.recover();
    res.json({ ok: true });
  });

  app.post("/settings/refresh", statusAccess, requireSession, async (_req, res) => {
    try {
      await line.refreshContacts();
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/settings/test", statusAccess, requireSession, async (req, res) => {
    const body = asRecord(req.body) ?? {};
    const to = typeof body.to === "string" ? body.to.trim() : "";
    if (!to) {
      res.status(400).json({ ok: false, error: "to 必填" });
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
    const repeat = typeof body.repeat === "string" ? body.repeat.trim() : "";

    try {
      if (runAt !== undefined) {
        const job = line.schedule(parsed, runAt, repeat || undefined);
        res.json({ ok: true, scheduled: true, id: job.id, runAt: job.runAt, repeat: job.repeat });
        return;
      }
      await line.sendAdvanced(parsed);
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/settings/scheduled/cancel", statusAccess, requireSession, (req, res) => {
    const body = asRecord(req.body) ?? {};
    const id = typeof body.id === "string" ? body.id : "";
    if (!id || !line.cancelScheduled(id)) {
      res.status(404).json({ ok: false, error: "找不到排程" });
      return;
    }
    res.json({ ok: true });
  });

  app.post("/settings/scheduled/update", statusAccess, requireSession, (req, res) => {
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
    } else if (body.sendAt !== undefined && body.sendAt !== null && body.sendAt !== "") {
      const resolved = resolveRunAt({ sendAt: body.sendAt });
      if (resolved.error || resolved.runAt === undefined) {
        res.status(400).json({ ok: false, error: resolved.error ?? "sendAt 無效" });
        return;
      }
      patch.runAt = resolved.runAt;
    }
    if (body.repeat !== undefined) {
      const repeat = typeof body.repeat === "string" ? body.repeat.trim() : "";
      patch.repeat = repeat || null;
    }

    try {
      const job = line.updateScheduled(id, patch);
      if (!job) {
        res.status(404).json({ ok: false, error: "找不到排程" });
        return;
      }
      res.json({ ok: true, job });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/webhook", ipGuard, rateLimit, verifyWebhookAuth, async (req, res) => {
    const body = asRecord(req.body) ?? {};

    const targets = parseTargets(body.to);
    const allowedExtraTo =
      Array.isArray(body.messages) &&
      (body.messages as unknown[]).every((item) => {
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
    const repeat = typeof body.repeat === "string" ? body.repeat.trim() : "";

    const dedupKey =
      typeof req.header("x-idempotency-key") === "string"
        ? (req.header("x-idempotency-key") as string).trim()
        : "";
    if (dedupKey && isDuplicateIdempotency(dedupKey)) {
      logger.info("重複的 idempotency key，略過", { ip: req.ip, dedupKey });
      res.json({ ok: true, duplicate: true });
      return;
    }

    try {
      if (runAt !== undefined) {
        const job = line.schedule(inputs, runAt, repeat || undefined);
        if (dedupKey) markIdempotency(dedupKey);
        logger.info("訊息已排程", {
          ip: req.ip,
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

      await line.sendAdvanced(inputs);
      if (dedupKey) markIdempotency(dedupKey);
      logger.info("訊息已轉發", { ip: req.ip, count: inputs.length });
      res.json({ ok: true, count: inputs.length });
    } catch (error) {
      logger.error("轉發失敗", {
        ip: req.ip,
        targets,
        error: error instanceof Error ? error.message : String(error),
      });
      sendError(res, error);
    }
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    const status =
      typeof err?.status === "number"
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
