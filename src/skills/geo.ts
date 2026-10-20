/**
 * 地理小工具（共用）：haversine 距離、geohash 編解碼、台灣縣市粗判定。
 * 純函式，可測試；TDX 相關技能（YouBike、公車）共用。
 */

/** haversine 大圓距離（公尺）。 */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const r = 6371000;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** 經緯度 → geohash（precision 長度）。 */
export function geohashEncode(lat: number, lon: number, precision = 6): string {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let out = "";
  let bits = 0;
  let value = 0;
  let even = true;
  while (out.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        value = value * 2 + 1;
        lonMin = mid;
      } else {
        value = value * 2;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        value = value * 2 + 1;
        latMin = mid;
      } else {
        value = value * 2;
        latMax = mid;
      }
    }
    even = !even;
    bits++;
    if (bits === 5) {
      out += GEOHASH_BASE32[value];
      bits = 0;
      value = 0;
    }
  }
  return out;
}

/** geohash → cell 四界（供鄰格計算）。 */
export function geohashBbox(hash: string): { latMin: number; latMax: number; lonMin: number; lonMax: number } {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let even = true;
  for (const c of hash.toLowerCase()) {
    const value = GEOHASH_BASE32.indexOf(c);
    if (value < 0) break;
    for (let mask = 16; mask > 0; mask >>= 1) {
      if (even) {
        const mid = (lonMin + lonMax) / 2;
        if (value & mask) lonMin = mid;
        else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (value & mask) latMin = mid;
        else latMax = mid;
      }
      even = !even;
    }
  }
  return { latMin, latMax, lonMin, lonMax };
}

/**
 * 該點所在 cell＋周圍 8 格（precision 6 約 1.2×0.6km，9 格涵蓋約 3.6×1.8km）。
 * 用格角微偏移重編碼（免鄰接表，台灣本島無極區問題）。
 */
export function geohashNeighbors(lat: number, lon: number, precision = 6): string[] {
  const center = geohashEncode(lat, lon, precision);
  const b = geohashBbox(center);
  const eps = 1e-9;
  const pts: Array<[number, number]> = [
    [lat, lon],
    [b.latMax + eps, lon],
    [b.latMin - eps, lon],
    [lat, b.lonMax + eps],
    [lat, b.lonMin - eps],
    [b.latMax + eps, b.lonMax + eps],
    [b.latMax + eps, b.lonMin - eps],
    [b.latMin - eps, b.lonMax + eps],
    [b.latMin - eps, b.lonMin - eps],
  ];
  return [...new Set(pts.map(([a, o]) => geohashEncode(a, o, precision)))];
}

interface Bbox {
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
  city: string;
}

/**
 * 台灣縣市粗框（由小排到大；重疊區回傳多個候選，呼叫端按序試到有資料為止）。
 * 框是 generous 的——邊界誤判由「多候選＋有資料才採用」吸收。
 */
const CITY_BOXES: Bbox[] = [
  { lonMin: 121.65, lonMax: 121.85, latMin: 25.08, latMax: 25.22, city: "Keelung" },
  { lonMin: 121.28, lonMax: 122.0, latMin: 24.96, latMax: 25.33, city: "Taipei" },
  { lonMin: 120.95, lonMax: 122.2, latMin: 24.7, latMax: 25.45, city: "NewTaipei" },
  { lonMin: 120.95, lonMax: 121.5, latMin: 24.7, latMax: 25.2, city: "Taoyuan" },
  { lonMin: 120.92, lonMax: 121.05, latMin: 24.75, latMax: 24.87, city: "Hsinchu" },
  { lonMin: 120.9, lonMax: 121.45, latMin: 24.55, latMax: 24.95, city: "HsinchuCounty" },
  { lonMin: 120.55, lonMax: 121.15, latMin: 24.2, latMax: 24.7, city: "MiaoliCounty" },
  { lonMin: 120.45, lonMax: 121.35, latMin: 23.95, latMax: 24.55, city: "Taichung" },
  { lonMin: 120.25, lonMax: 120.75, latMin: 23.75, latMax: 24.25, city: "ChanghuaCounty" },
  { lonMin: 120.55, lonMax: 121.25, latMin: 23.55, latMax: 24.1, city: "NantouCounty" },
  { lonMin: 120.05, lonMax: 120.65, latMin: 23.45, latMax: 23.9, city: "YunlinCounty" },
  { lonMin: 120.4, lonMax: 120.5, latMin: 23.43, latMax: 23.53, city: "Chiayi" },
  { lonMin: 120.05, lonMax: 120.75, latMin: 23.2, latMax: 23.65, city: "ChiayiCounty" },
  { lonMin: 119.9, lonMax: 120.65, latMin: 22.9, latMax: 23.5, city: "Tainan" },
  { lonMin: 119.9, lonMax: 120.75, latMin: 22.35, latMax: 23.25, city: "Kaohsiung" },
  { lonMin: 119.9, lonMax: 121.0, latMin: 21.85, latMax: 22.7, city: "PingtungCounty" },
  { lonMin: 121.55, lonMax: 122.1, latMin: 24.35, latMax: 24.95, city: "YilanCounty" },
  { lonMin: 121.25, lonMax: 121.85, latMin: 23.1, latMax: 24.35, city: "HualienCounty" },
  { lonMin: 120.75, lonMax: 121.4, latMin: 22.45, latMax: 23.45, city: "TaitungCounty" },
  { lonMin: 119.3, lonMax: 119.75, latMin: 23.15, latMax: 23.85, city: "PenghuCounty" },
  { lonMin: 118.15, lonMax: 118.65, latMin: 24.35, latMax: 24.6, city: "KinmenCounty" },
  { lonMin: 119.85, lonMax: 120.3, latMin: 25.95, latMax: 26.4, city: "LienchiangCounty" },
];

/** 經緯度 → 可能縣市（小框優先；呼叫端依序試到有資料）。 */
export function detectCities(lat: number, lon: number): string[] {
  return CITY_BOXES.filter(
    (b) => lon >= b.lonMin && lon <= b.lonMax && lat >= b.latMin && lat <= b.latMax,
  ).map((b) => b.city);
}

export function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return "";
  return m < 1000 ? `約${Math.round(m)}公尺` : `約${(m / 1000).toFixed(1)}公里`;
}
