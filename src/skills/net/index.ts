import { promises as dns } from "node:dns";
import { logger } from "@lw/logger";
import { fetchText } from "@lw/net";
import type { SkillContext, SkillDefinition, SkillHealth } from "@lw/skills/types";

const IP_APIS = ["https://api.ipify.org", "https://ipinfo.io/ip"];

/** 取得對外 IP（兩個免 key 來源，失敗拋錯）。 */
export async function publicIp(): Promise<string> {
  let lastErr = "";
  for (const url of IP_APIS) {
    try {
      const text = (await fetchText(url, {}, { timeoutMs: 8000, maxBytes: 4096 })).trim();
      if (text) return text;
    } catch (error) {
      lastErr = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastErr || "IP 查詢失敗");
}

export interface DnsResult {
  host: string;
  a: string[];
  aaaa: string[];
  mx: string[];
  error: string;
}

/** DNS 查詢（A / AAAA / MX；個別失敗不影響其他）。 */
export async function dnsLookup(host: string): Promise<DnsResult> {
  const out: DnsResult = { host, a: [], aaaa: [], mx: [], error: "" };
  try {
    out.a = await dns.resolve4(host);
  } catch {
    // resolve4 用 DNS 協定； hosts 檔或內網名稱改用 OS 解析
  }
  if (out.a.length === 0) {
    try {
      const found = await dns.lookup(host, { all: true });
      out.a = found.map((x) => x.address);
    } catch {
      // 查無
    }
  }
  if (out.a.length === 0 && !out.error) out.error = "查無 A 紀錄";
  try {
    out.aaaa = await dns.resolve6(host);
  } catch {
    // 沒有 IPv6 很常見，略過
  }
  try {
    const mxs = await dns.resolveMx(host);
    out.mx = mxs.sort((x, y) => x.priority - y.priority).map((m) => `${m.exchange}（${m.priority}）`);
  } catch {
    // 沒有 MX 很常見，略過
  }
  return out;
}

export function formatDns(r: DnsResult): string {
  if (r.a.length === 0 && r.aaaa.length === 0 && r.mx.length === 0) {
    return `DNS 查無 ${r.host} 的紀錄${r.error ? `（${r.error}）` : ""}。`;
  }
  const lines = [`🌐 ${r.host}`];
  if (r.a.length > 0) lines.push(`A：${r.a.join("、")}`);
  if (r.aaaa.length > 0) lines.push(`AAAA：${r.aaaa.join("、")}`);
  if (r.mx.length > 0) lines.push(`MX：${r.mx.join("、")}`);
  return lines.join("\n");
}

const netSkill: SkillDefinition = {
  id: "net",
  name: "網路工具",
  description: {
    zh: "查自己的對外 IP、DNS 紀錄（A/AAAA/MX），自架除錯用（免 key）。",
    en: "Check your public IP and DNS records (A/AAAA/MX) for self-hosting (no key).",
    ja: "自分のグローバル IP と DNS 記録（A/AAAA/MX）を確認（キー不要）。",
  },
  usage: {
    zh: "網路 我的IP；網路 dns google.com；網路 whois example.com",
    en: "net myip; net dns google.com; net whois example.com",
    ja: "ネット 私のIP; ネット dns google.com; ネット whois example.com",
  },
  category: { zh: "工具", en: "Utilities", ja: "ツール" },
  defaultTrigger: "網路",
  naturalKeywords: ["我的ip", "查ip"],
  triggerAliases: ["ip", "dns", "我的ip", "myip", "net"],
  fields: [],
  async health(): Promise<SkillHealth[]> {
    return [{ name: "網路工具", ok: true, detail: "就緒（ipify + node:dns）" }];
  },
  async run(ctx: SkillContext): Promise<void> {
    const args = ctx.args.replace(/請幫忙|請幫|幫忙|的/g, " ").trim();
    const host = args.replace(/dns|紀錄|domain|查詢|查一下|查|誰|whois|ip/i, " ").trim();

    // DNS 模式（有 dns 關鍵字或後面帶了網域）
    if (/dns|紀錄|domain|whois/i.test(args) || (host && !/ip/i.test(args) && !host.includes(" "))) {
      if (!host) {
        await ctx.reply("用法：網路 dns google.com（查 A / AAAA / MX 紀錄）");
        return;
      }
      try {
        const r = await dnsLookup(host);
        await ctx.reply(formatDns(r));
      } catch (error) {
        logger.warn("DNS 查詢失敗", { host, error: error instanceof Error ? error.message : String(error) });
        await ctx.reply(`DNS 查詢 ${host} 失敗，請確認網域是否正確。`);
      }
      return;
    }

    // 對外 IP
    try {
      const ip = await publicIp();
      await ctx.reply(`🌍 你的對外 IP：${ip}`);
    } catch (error) {
      logger.warn("IP 查詢失敗", { error: error instanceof Error ? error.message : String(error) });
      await ctx.reply("IP 查詢服務暫時無法連線，請稍後再試。");
    }
  },
};

export default netSkill;
