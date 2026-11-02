/**
 * P3 群組 @：各平台的 @ 寫法不同，這裡集中轉換。
 * - LINE 官方：原生 mention 物件（見 line-official client）
 * - Discord：`<@id>` 文字 + allowed_mentions
 * - Telegram / WhatsApp / LINE 自帳號：純文字 `@暱稱`（平台會自動連字／通知）
 * - Teams：`<at>暱稱</at>`
 */

export type MentionStyle = "line-native" | "discord" | "text" | "teams";

/** 平台 → @ 風格。 */
export function mentionStyle(platform: string): MentionStyle {
  if (platform === "discord") return "discord";
  if (platform === "teams") return "teams";
  return "text";
}

/** 把 mention 清單轉成要附加在文字前面的片段（各平台格式）。 */
export function mentionPrefix(platform: string, mentions: string[] | undefined): string {
  const list = (mentions ?? []).map((m) => (m ?? "").trim()).filter(Boolean);
  if (list.length === 0) return "";
  if (platform === "discord") return list.map((m) => `<@${m}> `).join("");
  if (platform === "teams") return list.map((m) => `<at>${m}</at> `).join("");
  return list.map((m) => (m.startsWith("@") ? m : `@${m}`)).join(" ") + " ";
}

/** 文字 + mention 前綴（文字為空時只回 mention 片段）。 */
export function withMentions(platform: string, text: string, mentions: string[] | undefined): string {
  const prefix = mentionPrefix(platform, mentions);
  if (!prefix) return text;
  return `${prefix}${text}`;
}
