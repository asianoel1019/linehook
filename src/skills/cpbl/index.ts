import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const ZXC_FIRST = "https://zxc22.idv.tw/rank_up.asp?clickflag=999";
const ZXC_SECOND = "https://zxc22.idv.tw/rank_up2.asp";

const TEAM_KEYWORDS: Record<string, string[]> = {
  味全龍: ["味全龍", "味全"],
  富邦悍將: ["富邦悍將", "富邦", "悍將"],
  台鋼雄鷹: ["台鋼雄鷹", "台鋼", "雄鷹"],
  "統一7-ELEVEn獅": ["統一7-ELEVEn獅", "統一獅", "統一"],
  樂天桃猿: ["樂天桃猿", "樂天", "桃猿"],
  中信兄弟: ["中信兄弟", "中信", "兄弟"],
};

export const TEAMS = Object.keys(TEAM_KEYWORDS);

/** 從文字中找出指名的球隊（找不到回 undefined）。 */
export function findTeam(args: string): string | undefined {
  for (const [team, keys] of Object.entries(TEAM_KEYWORDS)) {
    if (keys.some((k) => args.includes(k))) return team;
  }
  return undefined;
}

/** 儲存格是否提到某隊（官網/球迷站皆用全名）。 */
function cellTeam(cell: string): string | undefined {
  return TEAMS.find((t) => cell.includes(t === "統一7-ELEVEn獅" ? "統一" : t));
}

function hasTeam(cells: string[]): boolean {
  return cells.some((c) => cellTeam(c) !== undefined);
}

export interface StandingRow {
  rank: string;
  team: string;
  record: string;
  pct: string;
  gb: string;
  games: number;
}

function rowCells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map((m) =>
      m[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&#0*32;/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

/** 官網戰績表（UTF-8）：列為 排名|球隊|出賽|勝-敗-和|勝率|勝差|… */
export function parseOfficialRows(html: string): StandingRow[] {
  const out: StandingRow[] = [];
  for (const tb of html.matchAll(/<table[\s\S]*?>([\s\S]*?)<\/table>/gi)) {
    const rows = [...tb[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => rowCells(m[1]));
    if (!rows.some(hasTeam)) continue;
    for (const cells of rows) {
      const teamIdx = cells.findIndex((c) => cellTeam(c) !== undefined);
      if (teamIdx < 1) continue;
      const team = cellTeam(cells[teamIdx]) ?? cells[teamIdx];
      const rank = cells[teamIdx - 1] || "";
      if (!/^\d+$/.test(rank.trim())) continue;
      out.push({
        rank: rank.trim(),
        team,
        record: cells[teamIdx + 2] ?? cells[teamIdx + 1] ?? "",
        pct: cells[teamIdx + 3] ?? cells[teamIdx + 2] ?? "",
        gb: cells[teamIdx + 4] ?? cells[teamIdx + 3] ?? "",
        games: 0,
      });
    }
    if (out.length > 0) return out;
  }
  return out;
}

/** zxc22 戰績表（已解碼為文字）：欄位位置以表頭列定位，適應上下半季不同欄位。 */
export function parseZxcRows(text: string): StandingRow[] {
  const rows = [...text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => rowCells(m[1]));
  const header = rows.find(
    (cells) => cells.some((c) => /^(名次|排名)$/.test(c)) && cells.some((c) => /勝差/.test(c)),
  );
  const col = (names: string[], fallback: number): number => {
    if (!header) return fallback;
    const i = header.findIndex((c) => names.some((n) => c === n));
    return i >= 0 ? i : fallback;
  };
  let gbIdx = -1;
  if (header) {
    gbIdx = header.findIndex((c) => /勝差.*第一名/.test(c));
    if (gbIdx < 0) gbIdx = header.findIndex((c) => /勝差/.test(c));
  }
  if (gbIdx < 0) gbIdx = 9;
  const wIdx = col(["勝"], 5);
  const lIdx = col(["敗"], 6);
  const tIdx = col(["和"], 7);
  const pctIdx = col(["勝率"], 8);
  const gIdx = col(["已賽", "出賽"], 4);
  const out: StandingRow[] = [];
  for (const cells of rows) {
    if (cells.length < 10 || !/^\d+$/.test(cells[0].trim())) continue;
    const team = cellTeam(cells[1]);
    if (!team) continue;
    out.push({
      rank: cells[0].trim(),
      team,
      record: `${cells[wIdx] ?? ""}-${cells[lIdx] ?? ""}-${cells[tIdx] ?? ""}`,
      pct: (cells[pctIdx] ?? "").replace(/\s+/g, ""),
      gb: (cells[gbIdx] ?? "").replace(/\s+/g, ""),
      games: Number(cells[gIdx]) || 0,
    });
  }
  return out;
}

async function fetchZxc(url: string): Promise<StandingRow[]> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; LineHook/1.0)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > 512 * 1024) throw new Error("回應過大");
  return parseZxcRows(new TextDecoder("big5").decode(buf));
}

const cpblSkill: SkillDefinition = {
  id: "cpbl",
  name: "中職戰績",
  description: {
    zh: "查詢中華職棒戰績排名（上下半季自動判斷）。",
    en: "CPBL standings (auto half-season).",
    ja: "CPBL の順位表。",
  },
  usage: {
    zh: "中職",
    en: "cpbl standings",
    ja: "中職",
  },
  category: {
    zh: "生活資訊",
    en: "Life",
    ja: "生活",
  },
  defaultTrigger: "中職",
  triggerAliases: ["職棒", "cpbl", "中華職棒", "棒球"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 60 分鐘" },
  ],
  async health(): Promise<SkillHealth[]> {
    const results: SkillHealth[] = [];
    for (const [name, url] of [["zxc 上半季", ZXC_FIRST], ["zxc 下半季", ZXC_SECOND]] as Array<[string, string]>) {
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: { "User-Agent": "Mozilla/5.0 (compatible; LineHook/1.0)" },
          signal: AbortSignal.timeout(15_000),
        });
        results.push({ name, ok: res.ok, detail: `HTTP ${res.status}` });
      } catch {
        results.push({ name, ok: false, detail: "連線失敗" });
      }
    }
    return results;
  },
  async run(ctx: SkillContext): Promise<void> {
    const half = /下半季|下半/.test(ctx.args) ? "下半季" : /上半季|上半/.test(ctx.args) ? "上半季" : "";
    const teamKw = findTeam(ctx.args);
    const ttlMs = parseTtl(ctx.config.cacheTtl, 60);
    const cacheKey = `cpbl-${half || "auto"}`;
    try {
      let rows = readCache<StandingRow[]>(cacheKey, ttlMs);
      let source = "快取";
      if (!rows || rows.length === 0) {
        if (half) {
          rows = await fetchZxc(half === "下半季" ? ZXC_SECOND : ZXC_FIRST);
          source = `zxc 球迷站（${half}）`;
        } else {
          // 上下半季都抓，取已賽場次較多者（季中自動切到下半季）
          const [first, second] = await Promise.all([
            fetchZxc(ZXC_FIRST).catch(() => [] as StandingRow[]),
            fetchZxc(ZXC_SECOND).catch(() => [] as StandingRow[]),
          ]);
          const games = (rs: StandingRow[]) => rs.reduce((s, r) => s + r.games, 0);
          if (second.length > 0 && games(second) > games(first)) {
            rows = second;
            source = "zxc 球迷站（下半季）";
          } else if (first.length > 0) {
            rows = first;
            source = "zxc 球迷站（上半季）";
          } else {
            rows = second;
            source = "zxc 球迷站";
          }
        }
        if (rows.length === 0) throw new Error("解析不到戰績");
        writeCache(cacheKey, rows);
      }
      let list = rows;
      if (teamKw) {
        list = rows.filter((r) => r.team === teamKw);
        if (list.length === 0) {
          await ctx.reply(`查無「${teamKw}」的戰績。`);
          return;
        }
      }
      const title = teamKw ? `${teamKw} 戰績（${source}）` : `中職戰績${half ? `（${half}）` : ""}（${source}）：`;
      const lines = list.map((r) => `${r.rank}. ${r.team} ${r.record} 勝率${r.pct} 勝差${r.gb}`);
      logger.info("中職戰績查詢", { half, team: teamKw ?? "", count: list.length });
      await ctx.reply(`${title}\n${lines.join("\n")}`);
    } catch (error) {
      logger.error("中職戰績查詢失敗", { error: String(error) });
      await ctx.reply("戰績資料來源目前無法使用，請稍後再試。");
    }
  },
};

export default cpblSkill;
