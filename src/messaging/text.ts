function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 將長文字切成多段，優先切在換行，其次空白，最後硬切。limit <= 0 表示不切。 */
export function splitText(text: string, limit: number): string[] {
  if (limit <= 0 || text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    // 避免從 surrogate pair 中間切開（emoji 等）。
    while (cut > 0 && cut < rest.length && isLowSurrogate(rest.charCodeAt(cut)) && isHighSurrogate(rest.charCodeAt(cut - 1))) {
      cut -= 1;
    }
    if (cut <= 0) cut = Math.min(limit, rest.length);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * 長文字切段（含「(n/N) 」前綴預留與段數上限），各傳輸層共用。
 */
export function chunkReplyText(text: string, replyMaxChars: number): string[] {
  // 前綴「(n/N) 」會佔用長度，先預留再切段；段數設上限避免洗版。
  const maxLen = Math.max(200, replyMaxChars - 10);
  let parts = splitText(text, maxLen);
  const MAX_PARTS = 10;
  if (parts.length > MAX_PARTS) {
    parts = parts.slice(0, MAX_PARTS);
    parts[MAX_PARTS - 1] = `${parts[MAX_PARTS - 1]}…（內容過長已截斷）`;
  }
  return parts.map((part, i) => (parts.length > 1 ? `(${i + 1}/${parts.length}) ${part}` : part));
}
