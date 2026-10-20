import type { IncomingLocation } from "./types.js";

/** 緯度 -90–90、經度 -180–180 的基本 sanity（擋亂碼）。 */
function valid(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

function make(lat: number, lon: number): IncomingLocation | null {
  return valid(lat, lon) ? { latitude: lat, longitude: lon } : null;
}

/**
 * 從文字版位置訊息挖經緯度（部分平台把位置降級成文字＋地圖連結，
 * 例如 LINE 自帳號的「[ Location ]\\nhttps://maps.google.com/maps?q=25.06,121.59…」）。
 * 支援 Google（q/ll/@）、Apple（ll）、Bing（cp）、OSM（mlat/mlon）。
 */
export function extractLocationFromText(text: string): IncomingLocation | null {
  if (!text || !/maps|goo\.gl|lat|lon|cp=|mlat/i.test(text)) return null;

  // Google／Apple 共用：?q=lat,lon 或 &ll=lat,lon
  let m = /[?&](?:q|ll)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i.exec(text);
  if (m) {
    const loc = make(Number(m[1]), Number(m[2]));
    if (loc) return loc;
  }
  // Google 分享形：.../@lat,lon,15z
  m = /\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|\/|$)/.exec(text);
  if (m) {
    const loc = make(Number(m[1]), Number(m[2]));
    if (loc) return loc;
  }
  // Bing：?cp=lat~lon
  m = /[?&]cp=(-?\d+(?:\.\d+)?)~(-?\d+(?:\.\d+)?)/i.exec(text);
  if (m) {
    const loc = make(Number(m[1]), Number(m[2]));
    if (loc) return loc;
  }
  // OSM：?mlat=lat&mlon=lon
  const mlat = /[?&]mlat=(-?\d+(?:\.\d+)?)/i.exec(text);
  const mlon = /[?&]mlon=(-?\d+(?:\.\d+)?)/i.exec(text);
  if (mlat && mlon) {
    const loc = make(Number(mlat[1]), Number(mlon[1]));
    if (loc) return loc;
  }
  return null;
}
