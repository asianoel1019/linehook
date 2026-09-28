import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchJson as netFetchJson } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const LIVE_URL = "https://opendata.wra.gov.tw/api/v2/2be9044c-6e44-4856-aad5-dd108c2e6679?sort=_importdate%20asc&format=JSON";
const BASIC_URL = "https://opendata.wra.gov.tw/api/v2/708a43b0-24dc-40b7-9ed2-fca6a291e7ae?sort=_importdate%20asc&format=JSON";

interface LiveRow {
  reservoiridentifier?: string;
  observationtime?: string;
  waterlevel?: string;
  effectivewaterstoragecapacity?: string;
}

interface BasicRow {
  水庫名稱?: string;
  水庫代碼?: number | string;
  目前有效容量?: string;
}

export interface ReservoirStatus {
  id: string;
  name: string;
  time: string;
  levelM: number;
  storageWanM3: number;
  capacityWanM3: number;
  pct: number;
}

export function parseNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : NaN;
}

/** 有效蓄水量 ÷ 目前有效容量 × 100；任一無效回 NaN。 */
export function computePercent(storageWanM3: number, capacityWanM3: number): number {
  if (!Number.isFinite(storageWanM3) || !Number.isFinite(capacityWanM3) || capacityWanM3 <= 0) {
    return NaN;
  }
  return (storageWanM3 / capacityWanM3) * 100;
}

export function matchName(name: string, keyword: string): boolean {
  const norm = (s: string) => s.replace(/水庫$/, "").replace(/台/g, "臺").trim();
  const k = norm(keyword);
  const n = norm(name);
  if (!k) return false;
  return n.includes(k) || k.includes(n);
}

async function loadLive(ttlMs: number): Promise<LiveRow[]> {
  const cached = readCache<LiveRow[]>("reservoir-live", ttlMs);
  if (cached && cached.length > 0) return cached;
  const data = await netFetchJson<LiveRow[]>(LIVE_URL, undefined, {
    timeoutMs: 20_000,
    maxBytes: 4 * 1024 * 1024,
  });
  writeCache("reservoir-live", data);
  return data;
}

async function loadBasic(): Promise<BasicRow[]> {
  const cached = readCache<BasicRow[]>("reservoir-basic", 7 * 24 * 60 * 60 * 1000);
  if (cached && cached.length > 0) return cached;
  const data = await netFetchJson<BasicRow[]>(BASIC_URL, undefined, {
    timeoutMs: 20_000,
    maxBytes: 512 * 1024,
  });
  writeCache("reservoir-basic", data);
  return data;
}

export function joinStatus(live: LiveRow[], basic: BasicRow[]): ReservoirStatus[] {
  const baseMap = new Map<string, BasicRow>();
  for (const b of basic) {
    if (b.水庫代碼 !== undefined) baseMap.set(String(b.水庫代碼), b);
  }
  const seen = new Set<string>();
  const out: ReservoirStatus[] = [];
  for (const r of live) {
    const id = String(r.reservoiridentifier ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const b = baseMap.get(id);
    if (!b?.水庫名稱) continue;
    const storage = parseNum(r.effectivewaterstoragecapacity);
    const capacity = parseNum(b.目前有效容量);
    out.push({
      id,
      name: b.水庫名稱,
      time: (r.observationtime ?? "").replace("T", " ").slice(0, 16),
      levelM: parseNum(r.waterlevel),
      storageWanM3: storage,
      capacityWanM3: capacity,
      pct: computePercent(storage, capacity),
    });
  }
  return out;
}

const reservoirSkill: SkillDefinition = {
  id: "reservoir",
  name: "水庫水情",
  description: {
    zh: "查詢全台水庫蓄水量與蓄水率（水利署開放資料，免 key）。",
    en: "Taiwan reservoir storage levels (WRA open data, no key).",
    ja: "台湾ダムの貯水量・貯水率（水利署オープンデータ、キー不要）。",
  },
  usage: {
    zh: "水庫 石門",
    en: "reservoir Shimen",
    ja: "水庫 石門",
  },
  category: {
    zh: "生活資訊",
    en: "Life",
    ja: "生活",
  },
  defaultTrigger: "水庫",
  triggerAliases: ["水情", "蓄水", "reservoir"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 30 分鐘" },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      await loadLive(parseTtl(undefined, 30));
      return [{ name: "水利署水庫水情", ok: true, detail: "OK" }];
    } catch {
      return [{ name: "水利署水庫水情", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const keyword = ctx.args
      .replace(/請幫忙|請幫|幫忙|查詢|水庫|水情|蓄水|水位|的/g, " ")
      .trim();
    const ttlMs = parseTtl(ctx.config.cacheTtl, 30);
    try {
      const [live, basic] = await Promise.all([loadLive(ttlMs), loadBasic()]);
      const all = joinStatus(live, basic).filter((r) => Number.isFinite(r.pct));
      if (keyword) {
        const hit = all.find((r) => matchName(r.name, keyword));
        if (!hit) {
          await ctx.reply(`查無「${keyword}」水庫，請換個名稱試試（例如：水庫 石門）。`);
          return;
        }
        logger.info("水庫查詢", { name: hit.name });
        await ctx.reply(
          `${hit.name}（${hit.time}）：\n水位 ${Number.isFinite(hit.levelM) ? `${hit.levelM}m` : "—"}\n有效蓄水量 ${hit.storageWanM3.toLocaleString("en-US")} 萬m³（${hit.pct.toFixed(1)}%）`,
        );
        return;
      }
      const lowest = [...all]
        .filter((r) => r.capacityWanM3 >= 100)
        .sort((a, b) => a.pct - b.pct)
        .slice(0, 5);
      const lines = lowest.map((r) => `・${r.name} ${r.pct.toFixed(1)}%`);
      await ctx.reply(`蓄水率最低 5 座水庫：\n${lines.join("\n")}\n查單座請說：水庫 ○○（例如：水庫 石門）`);
    } catch (error) {
      logger.error("水庫查詢失敗", { error: String(error) });
      await ctx.reply("水庫資料來源目前無法使用，請稍後再試。");
    }
  },
};

export default reservoirSkill;
