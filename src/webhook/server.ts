import { mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { safeEqual } from "../safe-equal.js";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import QRCode from "qrcode";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getState } from "../state.js";
import { currentSettings, saveSettings } from "../settings.js";
import { getStats } from "../stats.js";
import { getTokenUsage } from "../token-stats.js";
import { listSkills, isBuiltinSkill, getSkill } from "../skills/index.js";
import { installZip, listInstalled, uninstallSkill } from "../skills/install.js";
import { validateSkillConfig } from "../skills/validate.js";
import { readBackupBundle, restoreBackupBundle } from "../backup.js";
import { audit } from "../audit.js";
import { llmConfigFrom, listModels } from "../skills/llm.js";
import { isLang, type Lang } from "../i18n.js";
import { NotLoggedInError, TargetNotFoundError, type FlexInput, type LocationInput, type SendInput, type StickerInput } from "../line/client.js";
import type { IMessagingService, Platform } from "../messaging/types.js";
import { getService, listServices } from "../messaging/services.js";
import { recordMetric, renderMetrics } from "../metrics.js";
import { llmUsage } from "../llm-usage.js";
import { persistInbound } from "../messaging/inbox.js";
import { verifyWhatsAppSignature } from "../whatsapp/client.js";
import { verifyTeamsJwt } from "../teams/client.js";
import { verifyLineSignature } from "../line-official/client.js";
import { mimeForName, resolveMediaFile, verifyMediaSignature } from "../media-url.js";
import { encryptSettings, decryptSettings, isEncryptedEnvelope } from "../settings-crypto.js";
import { reserveIdempotency, releaseIdempotency, requireSessionOrApi, verifyWebhookAuth, webhookAuthEnabled, type RawBodyRequest } from "../middleware/hmac.js";
import { getMessages, reloadMessages, searchMessages, purgeMessages } from "../messages.js";
import { readDeadLetters, purgeDeadLetters } from "../deadletter.js";
import { uploadHasRoom, uploadUsage } from "../uploads.js";
import { clientIp, ipGuard, isPrivateRequest } from "../middleware/ip.js";
import { loginRateLimit, rateLimit, recordLoginFailure, clearLoginFailures } from "../middleware/rateLimit.js";
import { changePassword, createSession, destroySession, hasSession, refreshSession, requireSameOrigin, requireSession, sessionRemainingMs, verifyCredentialsAsync, } from "../middleware/session.js";
import { parseCron } from "../line/cron.js";
import { parseDateTimeInTz } from "../time.js";
import { renderDashboardHtml } from "./pages/dashboard.js";
import { renderSettingsHtml } from "./pages/settings.js";
import { renderConsoleHtml } from "./pages/console.js";
import { renderSkillsHtml } from "./pages/skills.js";
import { renderLoginHtml } from "./pages/login.js";
import { renderReadmeHtml, sanitizeReadmeHtml as sanitizeReadmeHtmlImpl } from "./pages/readme.js";
import { renderMessagesHtml } from "./pages/messages.js";

/** 測試沿用：sanitizeReadmeHtml 原匯出自 server.ts，現轉匯出自 pages/readme。 */
export { sanitizeReadmeHtmlImpl as sanitizeReadmeHtml };

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
const ALL_PLATFORMS: Platform[] = ["line", "line-official", "telegram", "whatsapp", "teams", "discord"];
/** 某平台目前的登入 QR（若需人工掃描）。各服務自行提供 getQr()。 */
function platformQr(platform: string): string {
    const svc = getService(platform as Platform);
    return svc?.getQr?.() ?? "";
}
/** 各平台服務摘要（給 dashboard / status 用）。 */
function platformSummaries() {    return listServices().map((service) => ({
        platform: service.platform,
        targets: service.listTargets().length,
        queue: service.getQueueStats(),
        qr: platformQr(service.platform) ? true : false,
        status: service.loginStatus?.() ?? getState().status,
    }));
}
/** 固定時間比較字串（避免以回應時間洩漏密鑰）。 */
function constantTimeEqual(a: string, b: string): boolean {
    return safeEqual(a, b);
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
        if (dedupKey && !reserveIdempotency(dedupKey)) {
            logger.info("重複的 idempotency key，略過", { ip: req.ip, dedupKey });
            res.json({ ok: true, duplicate: true });
            return;
        }
        try {
            if (runAt !== undefined) {
                const job = service.schedule(inputs, runAt, repeat || undefined);
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
            logger.info("訊息已轉發", { ip: req.ip, platform: service.platform, count: inputs.length });
            res.json({ ok: true, count: inputs.length });
        }
        catch (error) {
            // 佔位後失敗要釋放，合法重試才可再送。
            if (dedupKey)
                releaseIdempotency(dedupKey);
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
    // 依 request body 的 platform 解析服務；未指定或 "line" 一律用 LINE 服務。
    const serviceFor = (req: Request): IMessagingService => {
        const body = asRecord(req.body) ?? {};
        const platform = typeof body.platform === "string" ? body.platform.trim() : "";
        if (platform && platform !== "line") {
            const svc = getService(platform as Platform);
            if (!svc) throw new Error(`平台未啟用：${platform}`);
            return svc;
        }
        return line;
    };
    app.disable("x-powered-by");
    // 只信任本機迴路 proxy，避免直接對外暴露時被偽造 X-Forwarded-For 繞過 IP 限制。
    app.set("trust proxy", "loopback");
    // D2：靜態資源（CSS/JS 由 public/ 提供，與 README.md、icons/ 同為 cwd 相對路徑）。
    app.use("/static", express.static(resolve("./public"), { maxAge: "1h", index: false }));
    app.use((_req, res, next) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
        next();
    });
    // C3：請求關聯 ID + access log（回傳 X-Request-Id 供追查）。
    // 同時記錄 C4 指標：請求數與耗時。
    app.use((req, res, next) => {
        const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        (req as { reqId?: string }).reqId = reqId;
        res.setHeader("X-Request-Id", reqId);
        const start = Date.now();
        res.on("finish", () => {
            logger.debug("HTTP", {
                reqId,
                method: req.method,
                path: req.path,
                status: res.statusCode,
                ms: Date.now() - start,
                ip: req.ip,
            });
            recordMetric("http_requests_total", 1, {
                method: req.method,
                route: req.route?.path ?? req.path,
                status: String(res.statusCode),
            });
            recordMetric("http_request_duration_ms_sum", Date.now() - start, {
                method: req.method,
                route: req.route?.path ?? req.path,
            });
        });
        next();
    });
    if (!webhookAuthEnabled()) {
        logger.warn("webhook 未啟用任何驗證（HMAC/Token/API Token），將接受所有來源呼叫");
    }
    app.use(express.json({
        limit: `${config.maxBodyMb}mb`,
        verify: (req, _res, buf) => {
            (req as RawBodyRequest).rawBody = buf;
        },
    }));
    app.get("/", (_req, res) => res.redirect("/dashboard"));
    // C4：Prometheus 文字格式指標（需 read 權限）。
    app.get("/metrics", statusAccess, requireSessionOrApi("read"), (_req, res) => {
        const lines: string[] = [renderMetrics().trimEnd()];
        for (const svc of listServices()) {
            const q = svc.getQueueStats();
            lines.push(`im_queue_depth{platform="${svc.platform}"} ${q.pending}`);
            const jobs = svc.listScheduled();
            const failed = jobs.filter((j) => j.lastError).length;
            lines.push(`scheduler_jobs{platform="${svc.platform}",state="scheduled"} ${jobs.length}`);
            lines.push(`scheduler_jobs{platform="${svc.platform}",state="failed"} ${failed}`);
        }
        res.set("Cache-Control", "no-store");
        res.type("text/plain; version=0.0.4").send(lines.join("\n") + "\n");
    });
    // K5：LLM 用量與費用估算（由 metrics counter 聚合，需 read 權限）。
    app.get("/llm/usage.json", statusAccess, requireSessionOrApi("read"), (_req, res) => {
        res.set("Cache-Control", "no-store");
        res.json(llmUsage());
    });
    // C1／J2：liveness——只要行程活著就 200，不呼叫任何平台（供 Docker HEALTHCHECK 與
    // 負載平衡器使用；平台掛掉時不該被重啟，那是 /health 的責任）。
    app.get("/healthz", (_req, res) => {
        res.set("Cache-Control", "no-store");
        res.json({ status: "ok", uptimeSec: Math.round(process.uptime()) });
    });
    // C1：各在線平台的健康狀態；任一異常即 503（供負載平衡／監控判斷）。
    app.get("/health", async (_req, res) => {
        const services = listServices();
        const detail: Record<string, boolean> = {};
        let allOk = services.length > 0;
        await Promise.all(services.map(async (svc) => {
            try {
                detail[svc.platform] = await svc.healthCheck();
            } catch {
                detail[svc.platform] = false;
            }
            if (!detail[svc.platform]) allOk = false;
        }));
        res.status(allOk ? 200 : 503).json({ status: allOk ? "ok" : "bad", services: detail });
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
            knownPlatforms: ALL_PLATFORMS,
            stats: getStats(config.statsDays, svc.platform),
            statsByPlatform,
            messages: getMessages().slice(-50),
            // J8：實際生效的檔案路徑（容器與主機可能不同，改設定卻沒生效時先看這裡）。
            paths: {
                settings: resolve(config.settingsPath),
                storage: resolve(config.line.storagePath),
                messages: resolve(config.messagesPath),
                schedules: resolve(config.schedulesPath),
                stats: resolve(config.statsPath),
                logFile: resolve(config.logFile),
            },
        });
    });
    app.get("/status.json", statusAccess, requireSessionOrApi("read"), (req, res) => {
        res.set("Cache-Control", "no-store");
        const platform = typeof req.query.platform === "string" ? req.query.platform : "";
        const isNonLine = Boolean(platform) && platform !== "line";
        const svc = isNonLine ? getService(platform as Platform) : line;
        const disabled = isNonLine && !svc;
        res.json({
            state: getState(),
            logs: logger.getRecent(),
            targets: disabled ? [] : (svc ?? line).listTargets(),
            queue: disabled ? { pending: 0, running: false } : (svc ?? line).getQueueStats(),
            scheduled: disabled ? [] : (svc ?? line).listScheduled(),
            platforms: platformSummaries(),
            knownPlatforms: ALL_PLATFORMS,
            disabled: disabled,
        });
    });
    app.get("/tokens/usage.json", statusAccess, requireSessionOrApi("admin"), (_req, res) => {
        res.set("Cache-Control", "no-store");
        res.json({ usage: getTokenUsage() });
    });
    app.get("/status/qr", statusAccess, requireSession, async (req, res) => {
        const platform = typeof req.query.platform === "string" ? req.query.platform : "";
        // WhatsApp（Web 模式）：QR 由 Baileys 產生，存於服務內。
        let qrUrl = getState().qrUrl;
        if (platform === "whatsapp") {
            const wa = getService("whatsapp") as { getQr?: () => string } | undefined;
            qrUrl = wa?.getQr?.() || "";
        }
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
    app.post("/login", statusAccess, loginRateLimit, async (req, res) => {
        const body = req.body;
        const user = typeof body?.user === "string" ? body.user : "";
        const pass = typeof body?.pass === "string" ? body.pass : "";
        if (!(await verifyCredentialsAsync(user, pass))) {
            const locked = recordLoginFailure(user);
            logger.warn("登入失敗", { ip: req.ip, locked });
            res.status(locked ? 429 : 401).json({ ok: false, error: locked ? "此帳號嘗試過於頻繁，請稍後再試" : "帳號或密碼錯誤" });
            return;
        }
        clearLoginFailures(user);
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
    // 技能健康探測：單技能 5 秒逾時，全體結果快取 60 秒（A7）。
    let skillsHealthCache: { at: number; health: Record<string, Array<{ name: string; ok: boolean; detail?: string }>> } | null = null;
    app.get("/skills/health", statusAccess, requireSessionOrApi("read"), async (_req, res) => {
        if (skillsHealthCache && Date.now() - skillsHealthCache.at < 60_000) {
            res.json({ health: skillsHealthCache.health, cached: true });
            return;
        }
        const result: Record<string, Array<{ name: string; ok: boolean; detail?: string }>> = {};
        const withTimeout = async <T>(name: string, task: Promise<T>): Promise<T> => {
            let timer: NodeJS.Timeout | undefined;
            try {
                return await Promise.race([
                    task,
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => reject(new Error(`${name} 健康檢查逾時（5s）`)), 5000);
                    }),
                ]);
            } finally {
                if (timer) clearTimeout(timer);
            }
        };
        await Promise.all(listSkills().map(async (skill) => {
            if (!skill.health)
                return;
            try {
                result[skill.id] = await withTimeout(skill.id, skill.health());
            }
            catch (error) {
                result[skill.id] = [{ name: "health", ok: false, detail: String(error) }];
            }
        }));
        skillsHealthCache = { at: Date.now(), health: result };
        res.json({ health: result, cached: false });
    });
    app.post("/skills/llm/models", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, rateLimit, async (req, res) => {
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
            audit(req, "skills.install", (result as { id?: string }).id ?? "");
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
        audit(req, "skills.uninstall", id);
        res.json({ ok: true });
    });
    app.post("/skills", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, (req, res) => {
        try {
            const body = asRecord(req.body) ?? {};
            const assistant = asRecord(body.assistant);
            const skills = Array.isArray(body.skills) ? body.skills : [];
            const current = currentSettings();
            const mappedSkills = skills.map((item: unknown) => {
                const s = asRecord(item) ?? {};
                const config = asRecord(s.config) ?? {};
                const configOut: Record<string, string> = {};
                for (const [k, v] of Object.entries(config))
                    configOut[k] = String(v ?? "");
                const rawAllowed = Array.isArray(s.allowedUsers) ? s.allowedUsers : [];
                return {
                    id: typeof s.id === "string" ? s.id : "",
                    enabled: s.enabled === true,
                    trigger: typeof s.trigger === "string" ? s.trigger : "",
                    allowedUsers: rawAllowed
                        .map((u: unknown) => String(u ?? "").trim())
                        .filter((u: string) => u.length > 0),
                    config: configOut,
                };
            });
            // F2：先驗證「啟用中」技能的欄位（指出技能與欄位），通過才存檔。
            const fieldErrors: string[] = [];
            for (const entry of mappedSkills) {
                if (!entry.enabled) continue;
                const def = getSkill(entry.id);
                if (!def) continue;
                fieldErrors.push(...validateSkillConfig(def, entry.config, config.language));
            }
            if (fieldErrors.length > 0) {
                res.status(400).json({ ok: false, error: fieldErrors.join("；") });
                return;
            }
            audit(req, "skills.save", mappedSkills.filter((s) => s.enabled).map((s) => s.id).join(","));
            const saved = saveSettings({
                ...current,
                assistant: assistant
                    ? {
                        enabled: assistant.enabled === true,
                        name: typeof assistant.name === "string" && assistant.name.trim() ? assistant.name.trim() : "阿寶",
                    }
                    : current.assistant,
                skills: mappedSkills,
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
    // I1：清除訊息紀錄（記憶體＋檔案），需二次確認由前端處理。
    app.post("/messages/purge", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, (req, res) => {
        const result = purgeMessages();
        audit(req, "messages.purge", `memory:${result.memory} file:${result.file}`);
        res.json({ ok: true, ...result });
    });
    // A3：死信列表（最近 100 筆，供檢視失敗原因）。
    app.get("/deadletter.json", statusAccess, requireSessionOrApi("read"), (req, res) => {
        res.set("Cache-Control", "no-store");
        const q = req.query;
        const limit = Number(typeof q.limit === "string" ? q.limit : "");
        res.json({ deadletters: readDeadLetters(Number.isFinite(limit) ? limit : 100) });
    });
    // K4：死信重送（payload 為失敗當下的 SendInput[]；技能類無 payload 不可重送）。
    app.post("/deadletter/retry", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, async (req, res) => {
        const body = asRecord(req.body) ?? {};
        const platform = typeof body.platform === "string" ? body.platform.trim() : "";
        const kind = typeof body.kind === "string" ? body.kind : "";
        const payload = Array.isArray(body.payload) ? body.payload : [];
        if (!platform) {
            res.status(400).json({ ok: false, error: "platform 必填" });
            return;
        }
        if (kind !== "send" && kind !== "scheduled" && kind !== "scheduled-misfired") {
            res.status(400).json({ ok: false, error: "此死信無法自動重送（技能類需重查原訊息）" });
            return;
        }
        if (payload.length === 0) {
            res.status(400).json({ ok: false, error: "舊資料無 payload，無法重送（此筆僅供檢視）" });
            return;
        }
        const svc = platform === "line" ? line : getService(platform as Platform);
        if (!svc) {
            res.status(400).json({ ok: false, error: `平台未啟用：${platform}` });
            return;
        }
        try {
            await svc.sendAdvanced(payload as never);
            audit(req, "deadletter.retry", `${platform}:${kind}`);
            res.json({ ok: true });
        }
        catch (error) {
            sendError(res, error);
        }
    });
    // K4：清除全部死信。
    app.post("/deadletter/purge", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, (req, res) => {
        const removed = purgeDeadLetters();
        audit(req, "deadletter.purge", `removed:${removed}`);
        res.json({ ok: true, removed });
    });
    // J3：備份（設定＋登入狀態＋排程），沿用 AES-256-GCM 加密；還原前自動備份現況。
    app.get("/settings/backup", statusAccess, requireSessionOrApi("admin"), (req, res) => {
        const password = typeof req.query.password === "string" ? req.query.password : "";
        if (!password) {
            res.status(400).json({ ok: false, error: "備份需設定密碼（?password=）" });
            return;
        }
        try {
            const bundle = readBackupBundle();
            const envelope = encryptSettings(bundle, password);
            audit(req, "settings.backup");
            res.set("Cache-Control", "no-store");
            res.setHeader("Content-Disposition", `attachment; filename="im-webhook-backup-${Date.now()}.enc.json"`);
            res.type("application/json").send(JSON.stringify(envelope, null, 2));
        } catch (error) {
            res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.post("/settings/backup/restore", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, (req, res) => {
        try {
            const body = asRecord(req.body) ?? {};
            const envelope = body.bundle ?? body.settings ?? req.body;
            if (!isEncryptedEnvelope(envelope)) {
                res.status(400).json({ ok: false, error: "不是有效的加密備份檔" });
                return;
            }
            const password = typeof body.password === "string" ? body.password : "";
            if (!password) {
                res.status(400).json({ ok: false, error: "還原需輸入備份時的密碼" });
                return;
            }
            let bundle: unknown;
            try {
                bundle = decryptSettings(envelope, password);
            } catch {
                res.status(400).json({ ok: false, error: "密碼錯誤或檔案已損毀" });
                return;
            }
            // 還原前先自動備份現況（防誤操作）。
            const safety = readBackupBundle();
            const safetyPath = `${config.settingsPath}.restore-bak-${Date.now()}.json`;
            try {
                writeFileSync(safetyPath, JSON.stringify(safety, null, 2), { mode: 0o600 });
            } catch (error) {
                logger.warn("還原前備份現況失敗", { error: String(error) });
            }
            const restored = restoreBackupBundle(bundle);
            reloadMessages();
            audit(req, "settings.backup.restore", `safety:${safetyPath}`);
            res.json({ ok: true, restored, safetyBackup: safetyPath });
        } catch (error) {
            res.status(400).json({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
    app.get("/settings.json", statusAccess, requireSessionOrApi("admin"), (_req, res) => {
        res.set("Cache-Control", "no-store");
        res.json(currentSettings());
    });
    app.get("/settings/export", statusAccess, requireSessionOrApi("admin"), (req, res) => {
        const data = currentSettings();
        const password = typeof req.query.password === "string" ? req.query.password : "";
        res.set("Cache-Control", "no-store");
        audit(req, "settings.export", password ? "encrypted" : "plaintext");
        if (password) {
            // 密碼加密匯出：整個設定以 AES-256-GCM 加密。
            const envelope = encryptSettings(data, password);
            res.setHeader("Content-Disposition", `attachment; filename="im-webhook-settings-${Date.now()}.enc.json"`);
            res.type("application/json").send(JSON.stringify(envelope, null, 2));
            return;
        }
        res.setHeader("Content-Disposition", `attachment; filename="im-webhook-settings-${Date.now()}.json"`);
        res.type("application/json").send(JSON.stringify(data, null, 2));
    });
    app.post("/settings/import", statusAccess, requireSessionOrApi("admin"), requireSameOrigin, (req, res) => {
        try {
            const body = asRecord(req.body) ?? {};
            let incoming: unknown = body.settings ?? req.body;
            // 若為加密信封，需 body.password 才能解。
            if (isEncryptedEnvelope(incoming)) {
                const password = typeof body.password === "string" ? body.password : "";
                if (!password) {
                    res.status(400).json({ ok: false, error: "此為加密設定檔，請輸入匯出時的密碼" });
                    return;
                }
                try {
                    incoming = decryptSettings(incoming, password);
                } catch {
                    res.status(400).json({ ok: false, error: "密碼錯誤或檔案已損毀" });
                    return;
                }
            }
            const saved = saveSettings(incoming);
            reloadMessages();
            logger.info("已匯入設定", { ip: req.ip });
            audit(req, "settings.import");
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
            // 設定頁只送出它管理的欄位；其餘（assistant / skills / language / statusPublic…）
            // 以現值補齊，避免被 schema 預設值覆蓋（例如助理名稱被重設回「阿寶」）。
            const body = asRecord(req.body) ?? {};
            const merged = { ...currentSettings(), ...body };
            const saved = saveSettings(merged);
            reloadMessages();
            audit(req, "settings.save");
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
        audit(req, "settings.password");
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
        // I2：總量配額，超過拒絕新的上傳。
        if (!uploadHasRoom(data.length)) {
            const usage = uploadUsage();
            logger.warn("上傳配額已滿，拒絕上傳", { bytes: data.length, usage });
            res.status(413).json({ ok: false, error: "上傳空間已滿，請先清理舊檔" });
            return;
        }
        try {
            mkdirSync(config.uploadsPath, { recursive: true });
            const safe = basename(name).replace(/[^\w.\-]+/g, "_") || "upload.bin";
            const stored = `${Date.now()}-${safe}`;
            const fullPath = resolve(config.uploadsPath, stored);
            writeFileSync(fullPath, data);
            logger.info("已上傳檔案", { file: stored, bytes: data.length });
            audit(req, "settings.upload", `${stored} (${data.length} bytes)`);
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
        let svc: IMessagingService;
        try {
            svc = serviceFor(req);
        }
        catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
            return;
        }
        if (!id || !svc.cancelScheduled(id)) {
            res.status(404).json({ ok: false, error: "找不到排程" });
            return;
        }
        audit(req, "scheduled.cancel", `${svc.platform}:${id}`);
        res.json({ ok: true, platform: svc.platform });
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
            const svc = serviceFor(req);
            const job = svc.updateScheduled(id, patch);
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
    // WhatsApp 發送端點：語意與 /webhook 相同，走 WhatsApp 服務。
    app.post("/webhook/wa", ipGuard, rateLimit, verifyWebhookAuth, makeWebhookSender(() => getService("whatsapp")));
    // Teams 發送端點：語意與 /webhook 相同，走 Teams 服務。
    app.post("/webhook/teams", ipGuard, rateLimit, verifyWebhookAuth, makeWebhookSender(() => getService("teams")));
    // Discord 發送端點：語意與 /webhook 相同（收訊走 Gateway 長連線，非 webhook）。
    app.post("/webhook/discord", ipGuard, rateLimit, verifyWebhookAuth, makeWebhookSender(() => getService("discord")));
    // E2：LINE 官方發送端點：語意與 /webhook 相同，走 Messaging API。
    app.post("/webhook/line-official", ipGuard, rateLimit, verifyWebhookAuth, makeWebhookSender(() => getService("line-official")));
    // E2：LINE 官方接收端點（Messaging API webhook）。驗 X-Line-Signature = base64(HMAC-SHA256(rawBody, channelSecret))。
    // channel secret 未設定就直接拒絕——這是該端點唯一的來源驗證，不做「未設定就放行」。
    app.post("/line-official/webhook", rateLimit, (req, res) => {
        const service = getService("line-official");
        if (!service || !config.lineOfficial.enabled || !config.lineOfficial.channelAccessToken.trim()) {
            res.status(503).json({ ok: false, error: "LINE 官方未啟用" });
            return;
        }
        const secret = config.lineOfficial.channelSecret.trim();
        if (!secret) {
            logger.error("LINE 官方 webhook 拒絕：未設定 channel secret（LINE_OFFICIAL_CHANNEL_SECRET）");
            res.status(503).json({ ok: false, error: "未設定 channel secret，無法驗證來源" });
            return;
        }
        const rawBody = (req as RawBodyRequest).rawBody;
        const signature = req.header("x-line-signature") ?? "";
        if (!rawBody || !verifyLineSignature(rawBody, signature, secret)) {
            logger.warn("LINE 官方 webhook 簽章不符", { ip: clientIp(req) });
            res.status(403).json({ ok: false });
            return;
        }
        // 先落地再回 200：崩潰時仍可追溯（見 messaging/inbox.ts）。
        persistInbound("line-official", req.body);
        // LINE 要求盡快回 200，否則會重送；實際處理非同步進行。
        res.json({ ok: true });
        void Promise.resolve(service.handleIncoming?.(req.body)).catch((error: unknown) => {
            logger.error("LINE 官方 webhook 處理失敗", { error: error instanceof Error ? error.message : String(error) });
        });
    });
    // E2：公開媒體（LINE 只收 HTTPS URL）。路徑帶 HMAC 簽章與時效，僅限上傳／快取目錄內的檔案。
    app.get("/media/:exp/:sig/:name", (req, res) => {
        const exp = Number(req.params.exp);
        const sig = String(req.params.sig ?? "");
        const name = String(req.params.name ?? "");
        if (!verifyMediaSignature(exp, sig, name)) {
            res.status(403).json({ ok: false, error: "無效或過期的媒體連結" });
            return;
        }
        const file = resolveMediaFile(name);
        if (!file) {
            res.status(404).json({ ok: false, error: "檔案不存在" });
            return;
        }
        res.set("Cache-Control", `public, max-age=${Math.max(0, exp - Math.floor(Date.now() / 1000))}`);
        res.type(mimeForName(name));
        res.sendFile(file, (error) => {
            if (error) logger.warn("媒體檔案送出失敗", { name, error: String(error) });
        });
    });
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
        // 先落地再回 200：崩潰時仍可追溯（見 messaging/inbox.ts）。
        persistInbound("telegram", req.body);
        // 先回 200 避免 Telegram 重送；實際處理非同步進行。
        res.json({ ok: true });
        void Promise.resolve(service.handleIncoming?.(req.body)).catch((error: unknown) => {
            logger.error("Telegram update 處理失敗", {
                error: error instanceof Error ? error.message : String(error),
            });
        });
    });
    // WhatsApp 接收端點。
    // GET：Meta 訂閱驗證（hub.mode=subscribe、hub.verify_token、hub.challenge）。
    app.get("/wa/webhook", (req, res) => {
        // Web（個人帳號）模式不需要 Meta webhook。
        if (config.whatsapp.mode !== "cloud") {
            res.status(503).json({ ok: false, error: "WhatsApp 為個人帳號模式，不使用 webhook" });
            return;
        }
        const mode = req.query["hub.mode"];
        const token = req.query["hub.verify_token"];
        const challenge = req.query["hub.challenge"];
        const expected = config.whatsapp.verifyToken.trim();
        if (mode === "subscribe" && expected && token === expected) {
            res.status(200).type("text/plain").send(String(challenge ?? ""));
            return;
        }
        logger.warn("WhatsApp webhook 驗證失敗", { ip: clientIp(req) });
        res.sendStatus(403);
    });
    // POST：接收訊息，驗 X-Hub-Signature-256（sha256=HMAC-SHA256(appSecret, rawBody)）。
    app.post("/wa/webhook", rateLimit, (req, res) => {
        const service = getService("whatsapp");
        if (config.whatsapp.mode !== "cloud") {
            res.status(503).json({ ok: false, error: "WhatsApp 為個人帳號模式，不使用 webhook" });
            return;
        }
        if (!service || !config.whatsapp.enabled || !config.whatsapp.accessToken.trim() || !config.whatsapp.phoneNumberId.trim()) {
            res.status(503).json({ ok: false, error: "WhatsApp 未啟用" });
            return;
        }
        const appSecret = config.whatsapp.appSecret.trim();
        if (appSecret) {
            const rawBody = (req as RawBodyRequest).rawBody;
            const signature = req.header("x-hub-signature-256") ?? "";
            if (!rawBody || !verifyWhatsAppSignature(rawBody, signature, appSecret)) {
                logger.warn("WhatsApp webhook 簽章不符", { ip: clientIp(req) });
                res.status(403).json({ ok: false });
                return;
            }
        }
        // 先落地再回 200：崩潰時仍可追溯（見 messaging/inbox.ts）。
        persistInbound("whatsapp", req.body);
        // 先回 200 避免 Meta 重送；實際處理非同步進行。
        res.json({ ok: true });
        void Promise.resolve(service.handleIncoming?.(req.body)).catch((error: unknown) => {
            logger.error("WhatsApp webhook 處理失敗", {
                error: error instanceof Error ? error.message : String(error),
            });
        });
    });
    // Teams 接收端點：由 Bot Connector 推送 activity 進來，驗 Bearer JWT（公開金鑰驗簽＋audience＝App ID）。
    app.post("/teams/messages", rateLimit, async (req, res) => {
        const service = getService("teams");
        if (!service || !config.teams.enabled || !config.teams.appId.trim() || !config.teams.appPassword.trim()) {
            res.status(503).json({ ok: false, error: "Teams 未啟用" });
            return;
        }
        const auth = req.header("authorization") ?? "";
        const ok = await verifyTeamsJwt(auth, config.teams.appId.trim()).catch(() => false);
        if (!ok) {
            logger.warn("Teams activity 驗證失敗", { ip: clientIp(req) });
            res.status(403).json({ ok: false });
            return;
        }
        // 先落地再回 200：崩潰時仍可追溯（見 messaging/inbox.ts）。
        persistInbound("teams", req.body);
        // 先回 200 避免重送；實際處理非同步進行。
        res.json({ ok: true });
        void Promise.resolve(service.handleIncoming?.(req.body)).catch((error: unknown) => {
            logger.error("Teams activity 處理失敗", {
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