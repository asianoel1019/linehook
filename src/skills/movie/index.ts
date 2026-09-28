import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchText as netFetchText } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) (compatible; LineHook/1.0)";
const BASE = "https://www.atmovies.com.tw/showtime";

const REGIONS: Array<{ names: string[]; code: string; label: string }> = [
  { names: ["台北", "臺北"], code: "a02", label: "台北" },
  { names: ["桃園"], code: "a03", label: "桃園" },
  { names: ["新竹"], code: "a35", label: "新竹" },
  { names: ["台中", "臺中"], code: "a04", label: "台中" },
  { names: ["台南", "臺南"], code: "a06", label: "台南" },
  { names: ["高雄"], code: "a07", label: "高雄" },
  { names: ["基隆"], code: "a01", label: "基隆" },
  { names: ["苗栗"], code: "a37", label: "苗栗" },
  { names: ["彰化"], code: "a47", label: "彰化" },
  { names: ["雲林"], code: "a45", label: "雲林" },
  { names: ["南投"], code: "a49", label: "南投" },
  { names: ["嘉義"], code: "a05", label: "嘉義" },
  { names: ["宜蘭"], code: "a39", label: "宜蘭" },
  { names: ["花蓮"], code: "a38", label: "花蓮" },
  { names: ["台東", "臺東"], code: "a89", label: "台東" },
  { names: ["屏東"], code: "a87", label: "屏東" },
];

interface Theater {
  id: string;
  name: string;
}

interface Movie {
  title: string;
  version: string;
  times: string[];
}

async function fetchText(url: string): Promise<string> {
  return netFetchText(
    url,
    { headers: { "User-Agent": UA } },
    { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
  );
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function parseTheaters(html: string): Theater[] {
  const re = /<a href="\/showtime\/(t\d+a\d+)\/a\d+\/"[^>]*>\s*([^<]+)<\/a>/g;
  const out: Theater[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = stripTags(m[2]);
    if (name && !out.some((t) => t.id === m![1])) out.push({ id: m[1], name });
  }
  return out;
}

function parseMovies(html: string): Movie[] {
  const parts = html.split('id="theaterShowtimeTable"').slice(1);
  const movies: Movie[] = [];
  for (const part of parts) {
    const block = part.split('id="theaterShowtimeTable"')[0];
    const titleMatch = block.match(/<a href="\/movie\/[^"]+">\s*([^<]+)<\/a>/);
    if (!titleMatch) continue;
    const title = stripTags(titleMatch[1]);
    const versionMatch = block.match(/class="filmVersion">([^<]*)</);
    const times = [...block.matchAll(/<li>\s*(\d{1,2})[:：](\d{2})\s*<\/li>/g)].map(
      (x) => `${x[1].padStart(2, "0")}:${x[2]}`,
    );
    if (title && times.length > 0) movies.push({ title, version: versionMatch ? stripTags(versionMatch[1]) : "", times });
  }
  return movies;
}

function pickRegion(args: string, baseCode: string): { code: string; label: string } {
  for (const r of REGIONS) {
    if (r.names.some((n) => args.includes(n))) return { code: r.code, label: r.label };
  }
  const d = REGIONS.find((r) => r.code === baseCode) ?? REGIONS[0];
  return { code: d.code, label: d.label };
}

function pickTheater(theaters: Theater[], args: string): Theater | null {
  const compact = args.replace(/\s/g, "");
  for (const t of theaters) {
    const name = t.name.replace(/\s/g, "");
    const core = name.replace(/^(台北|臺北|新北|桃園|台中|臺中|台南|臺南|高雄|新竹|基隆)/, "");
    if (compact.includes(name) || (core.length >= 2 && compact.includes(core))) return t;
  }
  return null;
}

const movieSkill: SkillDefinition = {
  id: "movie",
  name: "電影時刻",
  description: {
    zh: "查詢電影院場次。",
    en: "Movie showtimes.",
    ja: "映画の上映スケジュール。",
  },
  usage: {
    zh: "電影時刻 台北信義威秀",
    en: "movie Vieshow Taipei",
    ja: "映画 台北信義威秀",
  },
  category: {
    zh: "生活資訊",
    en: "Life",
    ja: "生活",
  },
  defaultTrigger: "電影",
  triggerAliases: ["電影時刻", "場次", "時刻表", "movie", "威秀"],
  fields: [
    { key: "region", label: { zh: "預設地區代碼", en: "Default region code", ja: "既定地域コード" }, hint: "預設 a02（台北）" },
    { key: "cacheTtl", label: { zh: "場次快取時間（TTL）", en: "Showtime cache TTL", ja: "上映キャッシュ TTL" }, hint: "預設 90 分鐘；戲院清單固定快取 1 天" },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      const res = await fetch(`${BASE}/a02/`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(15_000),
      });
      return [{ name: "開眼電影網", ok: res.ok, detail: `HTTP ${res.status}` }];
    } catch {
      return [{ name: "開眼電影網", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const ttlMs = parseTtl(ctx.config.cacheTtl, 90);
    const region = pickRegion(ctx.args, (ctx.config.region || "a02").trim());

    let theaters: Theater[] | null = readCache<Theater[]>(`movie-theaters-${region.code}`, 1440);
    if (!theaters || theaters.length === 0) {
      try {
        theaters = parseTheaters(await fetchText(`${BASE}/${region.code}/`));
      } catch (error) {
        logger.warn("戲院清單取得失敗", { region: region.code, error: error instanceof Error ? error.message : String(error) });
        await ctx.reply("目前無法取得電影院資料，請稍後再試。");
        return;
      }
      if (theaters.length === 0) {
        await ctx.reply(`查不到 ${region.label} 的電影院清單。`);
        return;
      }
      writeCache(`movie-theaters-${region.code}`, theaters);
    }

    const theater = pickTheater(theaters, ctx.args) ?? theaters[0];
    const core = theater.name.replace(/^(台北|臺北|新北|桃園|台中|臺中|台南|臺南|高雄|新竹|基隆)/, "");
    let movieQuery = ctx.args
      .replace(/請幫忙|請幫|幫忙|幫我|查詢|查一下|電影時刻|時刻表|場次|電影|的|今天|今日|現在/g, " ")
      .replace(theater.name, " ")
      .replace(core, " ");
    for (const r of REGIONS) for (const n of r.names) movieQuery = movieQuery.split(n).join(" ");
    movieQuery = movieQuery.replace(/\s+/g, " ").trim();

    let movies: Movie[] | null = readCache<Movie[]>(`movie-${theater.id}`, ttlMs);
    if (!movies) {
      try {
        movies = parseMovies(await fetchText(`${BASE}/${theater.id}/${region.code}/`));
      } catch (error) {
        logger.warn("場次取得失敗", { theater: theater.id, error: error instanceof Error ? error.message : String(error) });
        await ctx.reply("目前無法取得場次資料，請稍後再試。");
        return;
      }
      writeCache(`movie-${theater.id}`, movies);
    }
    if (movies.length === 0) {
      await ctx.reply(`${theater.name} 今日查無場次。`);
      return;
    }

    const filtered = movieQuery
      ? movies.filter((m) => m.title.includes(movieQuery) || movieQuery.includes(m.title.replace(/[：:].*$/, "")))
      : movies;
    if (filtered.length === 0) {
      const names = movies.slice(0, 10).map((m) => m.title).join("、");
      await ctx.reply(`在 ${theater.name} 查不到「${movieQuery}」的場次。今日上映：${names}`);
      return;
    }

    const lines = filtered.slice(0, 8).map((m) => {
      const ver = m.version ? `（${m.version}）` : "";
      return `${m.title}${ver}\n ${m.times.join(" ")}`;
    });
    logger.info("電影時刻查詢", { theater: theater.id, count: filtered.length });
    await ctx.reply(`${theater.name} 電影時刻：\n${lines.join("\n")}`);
  },
};

export default movieSkill;
