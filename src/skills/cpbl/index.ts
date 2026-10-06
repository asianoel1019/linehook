import { logger } from "../../logger.js";
import { nowInTz } from "../../time.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const ZXC_FIRST = "https://zxc22.idv.tw/rank_up.asp?clickflag=999";
const ZXC_ALL = "https://zxc22.idv.tw/rank_all.asp";

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

// ---------------------------------------------------------------------------
// 賽季分段（E：依日期判斷目前處於哪個賽季）
// ---------------------------------------------------------------------------

export type SeasonSegment = "first" | "second" | "postseason" | "full";

/** 切點：球季開幕、上半季結束、例行賽（下半季）結束、季後賽結束（MM-DD，可於技能設定覆寫）。 */
export const DEFAULT_CUTOFFS = "03-15,07-06,10-10,11-15";

export const SEGMENT_LABEL: Record<SeasonSegment, string> = {
  first: "上半季",
  second: "下半季",
  postseason: "季後賽期間",
  full: "全年度",
};

/** 解析切點設定：接受「MM-DD,MM-DD,MM-DD,MM-DD」，缺漏或格式錯誤的欄位沿用預設。 */
export function parseCutoffs(raw?: string): string[] {
  const defaults = DEFAULT_CUTOFFS.split(",");
  const parts = (raw ?? "")
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return defaults.map((d, i) => {
    const m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(parts[i] ?? "");
    if (!m) return d;
    return `${String(Number(m[1])).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
  });
}

/** 把 `MM-DD` 正規化（補零），無法辨識時回傳原字串。 */
function normalizeMd(value: string): string {
  const m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(String(value).trim());
  if (!m) return String(value).trim();
  return `${String(Number(m[1])).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
}

/**
 * 依日期判斷目前處於哪個賽季段（字串比較 MM-DD，需已補零）。
 * 冬季與球季開始前／季後賽結束後都回 `full`（顯示上一季的全年度最終戰績）。
 */
export function detectSeasonSegment(monthDay: string, cutoffs: string[] = parseCutoffs()): SeasonSegment {
  const md = normalizeMd(monthDay);
  const [seasonStart, firstEnd, secondEnd, postEnd] = cutoffs.map(normalizeMd);
  if (md < seasonStart || md > postEnd) return "full";
  if (md <= firstEnd) return "first";
  if (md <= secondEnd) return "second";
  return "postseason";
}

const ARG_SEGMENTS: Array<[SeasonSegment, RegExp]> = [
  ["postseason", /季後|冠軍賽|總冠軍|台灣大賽|playoff|postseason/i],
  ["first", /上半季|上半|first\s*half/i],
  ["second", /下半季|下半|second\s*half/i],
  ["full", /全年度|全季|整季|年度戰績|full\s*season/i],
];

/** 先看指令參數（可明確指定），沒有才用日期判斷。 */
export function resolveSeasonSegment(args: string, monthDay: string, cutoffs?: string[]): SeasonSegment {
  for (const [segment, pattern] of ARG_SEGMENTS) {
    if (pattern.test(args)) return segment;
  }
  return detectSeasonSegment(monthDay, cutoffs);
}

function splitRecord(record: string): [number, number, number] | null {
  const m = /^(\d+)-(\d+)-(\d+)$/.exec((record ?? "").trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * 下半季＝全年度 − 上半季。
 *
 * zxc22 沒有獨立的下半季表（`rank_up2.asp` 目前回的仍是上半季資料），
 * 而兩張表同源且全年度＝上半季＋下半季，相減即可得到精確的下半季戰績，
 * 包含球季進行中（上半季已定案、下半季進行中）的情況。
 */
export function deriveSecondHalf(full: StandingRow[], first: StandingRow[]): StandingRow[] {
  const firstByTeam = new Map(first.map((r) => [r.team, r]));
  const out: StandingRow[] = [];
  for (const row of full) {
    const half = firstByTeam.get(row.team);
    if (!half) continue;
    const all = splitRecord(row.record);
    const halfRecord = splitRecord(half.record);
    if (!all || !halfRecord) continue;
    const w = all[0] - halfRecord[0];
    const l = all[1] - halfRecord[1];
    const t = all[2] - halfRecord[2];
    if (w < 0 || l < 0 || t < 0) continue;
    const games = w + l + t;
    if (games <= 0) continue;
    out.push({
      rank: "",
      team: row.team,
      record: `${w}-${l}-${t}`,
      pct: String(Number((w / games).toFixed(3))),
      gb: "",
      games,
    });
  }
  // 勝率高者在前；同勝率先比勝場、再比敗場少者。
  out.sort((a, b) => {
    const [aw, al] = splitRecord(a.record) ?? [0, 0, 0];
    const [bw, bl] = splitRecord(b.record) ?? [0, 0, 0];
    return Number(b.pct) - Number(a.pct) || bw - aw || al - bl;
  });
  const leader = splitRecord(out[0]?.record ?? "");
  out.forEach((row, index) => {
    row.rank = String(index + 1);
    if (index === 0 || !leader) {
      row.gb = "-";
      return;
    }
    const [w, l] = splitRecord(row.record) ?? [0, 0, 0];
    const gb = (leader[0] - w + (l - leader[1])) / 2;
    row.gb = Number.isInteger(gb) ? String(gb) : gb.toFixed(1);
  });
  return out;
}

interface SegmentData {
  rows: StandingRow[];
  source: string;
}

/** 抓取指定賽季段的戰績（下半季由全年度−上半季推算）。 */
async function fetchSegment(segment: SeasonSegment): Promise<SegmentData> {
  if (segment === "second") {
    const [full, first] = await Promise.all([
      fetchZxc(ZXC_ALL).catch(() => [] as StandingRow[]),
      fetchZxc(ZXC_FIRST).catch(() => [] as StandingRow[]),
    ]);
    const derived = deriveSecondHalf(full, first);
    if (derived.length > 0) return { rows: derived, source: "zxc・全年度−上半季推算" };
    logger.warn("下半季推算失敗，改用其他來源", { full: full.length, first: first.length });
    if (full.length > 0) return { rows: full, source: "zxc・暫示全年度" };
    if (first.length > 0) return { rows: first, source: "zxc・暫示上半季" };
    throw new Error("解析不到戰績");
  }
  const rows = await fetchZxc(segment === "first" ? ZXC_FIRST : ZXC_ALL);
  if (rows.length === 0) throw new Error("解析不到戰績");
  return { rows, source: "zxc 球迷站" };
}

/**
 * 勝差欄格式化：站方會在第一名的勝差欄放特殊標記（例如「封王」），
 * 直接接在「勝差」後面會變成「勝差封王」，改以「-（封王）」呈現。
 */
export function formatGb(gb: string): string {
  const v = (gb ?? "").replace(/\s+/g, "");
  if (v === "" || v === "-" || v === "---") return "-";
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return `-（${v}）`;
}

const cpblSkill: SkillDefinition = {
  id: "cpbl",
  name: "中職戰績",
  description: {
    zh: "查詢中華職棒戰績排名（依日期自動判斷上半季／下半季／季後賽／全年度）。",
    en: "CPBL standings (picks the season half by date).",
    ja: "CPBL の順位表（日付から上半季／下半季を自動判定）。",
  },
  usage: {
    zh: "中職（可加：上半季 / 下半季 / 全年度 / 季後賽 / 球隊名）",
    en: "cpbl standings (first half / second half / full / postseason)",
    ja: "中職（上半季／下半季／全年度／季後賽／チーム名）",
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
    {
      key: "cutoffs",
      label: { zh: "賽季切點（MM-DD）", en: "Season cutoffs (MM-DD)", ja: "シーズン境界（MM-DD）" },
      hint: "球季開幕,上半季結束,例行賽結束,季後賽結束；預設 03-15,07-06,10-10,11-15",
    },
  ],
  async health(): Promise<SkillHealth[]> {
    const results: SkillHealth[] = [];
    for (const [name, url] of [["zxc 上半季", ZXC_FIRST], ["zxc 全年度", ZXC_ALL]] as Array<[string, string]>) {
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
    const cutoffs = parseCutoffs(ctx.config.cutoffs);
    const now = nowInTz();
    const monthDay = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const year = now.getFullYear();
    const segment = resolveSeasonSegment(ctx.args, monthDay, cutoffs);
    const label = SEGMENT_LABEL[segment];
    const teamKw = findTeam(ctx.args);
    const ttlMs = parseTtl(ctx.config.cacheTtl, 60);
    const cacheKey = `cpbl-${segment}-${year}`;
    try {
      let data = readCache<SegmentData>(cacheKey, ttlMs);
      const fromCache = Boolean(data && data.rows && data.rows.length > 0);
      if (!fromCache) {
        data = await fetchSegment(segment);
        writeCache(cacheKey, data);
      }
      const source = data?.source ?? "zxc 球迷站";
      const cacheNote = fromCache ? "（快取）" : "";
      let list = data?.rows ?? [];
      if (list.length === 0) throw new Error("解析不到戰績");
      if (teamKw) {
        list = list.filter((r) => r.team === teamKw);
        if (list.length === 0) {
          await ctx.reply(`查無「${teamKw}」在${label}的戰績。`);
          return;
        }
      }
      const note = segment === "postseason" ? "\n註：例行賽已結束，以下為全年度最終戰績（季後賽無戰績表）。" : "";
      const head = teamKw ? `${teamKw} ${year} ${label}戰績` : `${year} ${label}戰績`;
      const title = `${head}（${source}）${cacheNote}${teamKw ? "" : "："}`;
      const lines = list.map((r) => `${r.rank}. ${r.team} ${r.record} 勝率${r.pct} 勝差${formatGb(r.gb)}`);
      logger.info("中職戰績查詢", { segment, monthDay, team: teamKw ?? "", count: list.length });
      await ctx.reply(`${title}\n${lines.join("\n")}${note}`);
    } catch (error) {
      logger.error("中職戰績查詢失敗", { segment, error: String(error) });
      await ctx.reply("戰績資料來源目前無法使用，請稍後再試。");
    }
  },
};

export default cpblSkill;
