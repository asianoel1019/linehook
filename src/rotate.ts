import { existsSync, renameSync, rmSync, statSync } from "node:fs";

/**
 * 若檔案超過 maxBytes 就輪替：path -> path.1，path.1 -> path.2 ... 保留 maxFiles 個舊檔。
 */
export function rotateIfNeeded(path: string, maxBytes: number, maxFiles: number): void {
  try {
    if (statSync(path).size <= maxBytes) return;
    const max = Math.max(1, maxFiles);
    for (let i = max - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      if (existsSync(from)) {
        if (i === max - 1) rmSync(from);
        else renameSync(from, `${path}.${i + 1}`);
      }
    }
    renameSync(path, `${path}.1`);
  } catch {
    // ignore rotation errors
  }
}
