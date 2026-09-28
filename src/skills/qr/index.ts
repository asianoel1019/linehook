import QRCode from "qrcode";
import { logger } from "../../logger.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const URL_RE = /https?:\/\/[^\s]+/i;

async function shorten(url: string): Promise<string> {
  try {
    const res = await fetch(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, {
      headers: { "User-Agent": "LineHook/1.0" },
    });
    if (res.ok) {
      const text = (await res.text()).trim();
      if (/^https?:\/\//.test(text)) return text;
    }
  } catch {
    // fall through
  }
  const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, {
    headers: { "User-Agent": "LineHook/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = (await res.text()).trim();
  if (!/^https?:\/\//.test(text)) throw new Error("縮網址失敗");
  return text;
}

const qrSkill: SkillDefinition = {
  id: "qr",
  name: "QR / 短網址",
  description: {
    zh: "產生 QR Code，並自動縮短網址中的連結。",
    en: "Generate a QR Code; shortens URLs in the text automatically.",
    ja: "QR コードを生成し、URL を自動短縮します。",
  },
  usage: {
    zh: "qr https://example.com",
    en: "qr https://example.com",
    ja: "qr https://example.com",
  },
  category: {
    zh: "工具",
    en: "Tools",
    ja: "ツール",
  },
  defaultTrigger: "qr",
  triggerAliases: ["QR", "二維碼", "qrcode", "短網址", "縮網址", "shorten"],
  fields: [],
  async health(): Promise<SkillHealth[]> {
    try {
      await QRCode.toDataURL("ok", { width: 64 });
      return [{ name: "QR 產生器", ok: true, detail: "OK" }];
    } catch {
      return [{ name: "QR 產生器", ok: false, detail: "無法產生" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const content = ctx.args
      .replace(/請幫忙|請幫|幫忙|幫我|產生|生成|製作|做一個|做個|的/g, " ")
      .trim();
    if (!content) {
      await ctx.reply("請提供內容，例如：阿寶請幫忙 qr https://example.com 或 qr 我的名片文字");
      return;
    }

    const url = URL_RE.exec(content)?.[0] ?? "";
    let short = "";
    if (url) {
      try {
        short = await shorten(url);
      } catch (error) {
        logger.warn("縮網址失敗", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const qrContent = short || url || content;

    try {
      const dataUrl = await QRCode.toDataURL(qrContent, { width: 360, margin: 1 });
      await ctx.sendImage(dataUrl, "qrcode.png");
    } catch (error) {
      logger.error("QR 產生失敗", { error: error instanceof Error ? error.message : String(error) });
      await ctx.reply("QR Code 產生失敗，請稍後再試。");
      return;
    }

    if (short) {
      await ctx.reply(`已縮短網址並產生 QR Code：\n${short}`);
    } else {
      await ctx.reply(`已產生 QR Code（內容：${qrContent.length > 60 ? `${qrContent.slice(0, 60)}…` : qrContent}）`);
    }
  },
};

export default qrSkill;
