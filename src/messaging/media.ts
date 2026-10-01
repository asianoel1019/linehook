import { isAbsolute, resolve, sep } from "node:path";

/**
 * 本機檔案只允許上傳/快取目錄，避免外部參數讀到任意系統檔案。
 * 傳輸層共用（LINE / Telegram / …）。
 */
export function resolveLocalMediaPath(
  source: string,
  uploadsPath: string,
  cachePath: string,
): string {
  const roots = [resolve(uploadsPath), resolve(cachePath)];
  const candidate = isAbsolute(source) ? resolve(source) : resolve(roots[0], source);
  for (const root of roots) {
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (candidate === root || candidate.startsWith(rootWithSep)) return candidate;
  }
  throw new Error("僅允許讀取上傳目錄內的檔案（請先經 /settings/upload 上傳）");
}
