// J4：secret scanning（自製、零相依、可本機重跑）。
// 為什麼不用 gitleaks/trufflehog：需要額外安裝或下載 binary、private repo 授權不確定、
// 規則無法在本機驗證 → CI 一旦誤報就擋住所有 push。這裡改用少數高信心 pattern，
// 只掃「已追蹤的檔案」，並以 allowlist 記錄刻意出現的範例字串。
// 用法：node .github/scripts/secret-scan.mjs（規則本身有 tests/secret-scan.test.ts 護著）
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 高信心的真實憑證 pattern（命中即 fail）。 */
export const RULES = [
  { name: "AWS access key id", re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/ },
  { name: "GitHub token (classic)", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Stripe live secret", re: /\bsk_live_[0-9a-zA-Z]{24,}\b/ },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{40,}\b/ },
  { name: "Telegram bot token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  {
    name: "Discord bot token",
    re: /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{25,}\b/,
  },
  { name: "Private key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
];

/**
 * 允許出現的例外。命中這裡不算失敗——新增前請想清楚並註明原因。
 * 格式：檔路徑（POSIX 相對）→ 該檔允許的 rule 名稱（"*" = 全部）。
 */
export const ALLOW = {
  ".github/scripts/secret-scan.mjs": ["*"],
  // 規則的已知正例（測試 fixture，非真實憑證）——tests/secret-scan.test.ts 用它驗證每條規則都有效。
  "tests/secret-scan.test.ts": [
    "AWS access key id",
    "Slack token",
    "Private key block",
    "GitHub token (classic)",
    "GitHub fine-grained PAT",
    "Google API key",
    "Stripe live secret",
    "Anthropic API key",
    "OpenAI API key",
    "Telegram bot token",
    "Discord bot token",
  ],
};

/** 掃一份內容，回 findings（`line [rule] 片段`）。binary 內容回空。 */
export function scanContent(content, allow = []) {
  if (content.indexOf("\0") !== -1) return [];
  const findings = [];
  const lines = content.split(/\r?\n/);
  for (const rule of RULES) {
    if (allow.includes(rule.name) || allow.includes("*")) continue;
    for (let i = 0; i < lines.length; i++) {
      const m = rule.re.exec(lines[i]);
      if (m) findings.push(`${i + 1} [${rule.name}] ${m[0].slice(0, 14)}`);
    }
  }
  return findings;
}

function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "buffer" });
  return out
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function main() {
  const files = listTrackedFiles();
  const findings = [];

  for (const file of files) {
    const posix = file.split(sep).join("/");
    const allow = Array.isArray(ALLOW[posix]) ? ALLOW[posix] : [];
    if (allow.includes("*")) continue;

    let content;
    try {
      content = readFileSync(join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const hit of scanContent(content, allow)) {
      findings.push(`${posix}:${hit}`);
    }
  }

  if (findings.length > 0) {
    console.error(`secret scanning failed: ${findings.length} suspected credential(s)`);
    for (const f of findings) console.error("  " + f);
    console.error("If it is an intentional example, add it to ALLOW in .github/scripts/secret-scan.mjs with a reason.");
    process.exit(1);
  }
  console.log(`secret scanning ok (${files.length} tracked files, ${RULES.length} rules)`);
}

// 只有被直接執行時才掃描（被 tests import 時不跑）。
if (process.argv[1] && resolve(process.argv[1]).endsWith(join("scripts", "secret-scan.mjs"))) {
  main();
}
