import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RULES, scanContent } from "../.github/scripts/secret-scan.mjs";

const NUL = String.fromCharCode(0);

/** 每條規則的已知正例（確保 pattern 真的認得出來，不是永遠掃不到東西）。 */
const SAMPLES: Array<[string, string]> = [
  ["AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
  ["GitHub token (classic)", "ghp_" + "a".repeat(36)],
  ["GitHub fine-grained PAT", "github_pat_" + "b".repeat(30)],
  ["Slack token", "xoxb-1234567890-abcdefghijkl"],
  ["Google API key", "AIza" + "A".repeat(35)],
  ["Stripe live secret", "sk_live_" + "c".repeat(24)],
  ["Anthropic API key", "sk-ant-" + "d".repeat(24)],
  ["OpenAI API key", "sk-" + "e".repeat(44)],
  ["Telegram bot token", "1234567890:" + "f".repeat(35)],
  ["Discord bot token", "g".repeat(26) + "." + "h".repeat(7) + "." + "i".repeat(27)],
  ["Private key block", "-----BEGIN RSA PRIVATE KEY-----"],
];

describe("secret-scan", () => {
  it("每條規則都認得自己的正例（規則不可失效）", () => {
    for (const rule of RULES) {
      const sample = SAMPLES.find(([n]) => n === rule.name);
      assert.ok(sample, `缺少 ${rule.name} 的範例`);
      const findings = scanContent(`const leak = "${sample[1]}";`);
      assert.equal(findings.length, 1, `${rule.name} 應被偵測到`);
      assert.ok(findings[0].includes(rule.name), `${rule.name} 應回報該規則名`);
    }
  });

  it("一般程式碼與範例字串不誤報", () => {
    const clean = [
      "# IM Webhook",
      "TELEGRAM_BOT_TOKEN=",
      "WHATSAPP_ACCESS_TOKEN=EAA...",
      'const placeholder = "sk-";',
      "password: process.env.STATUS_PASS,",
      "https://hooks.slack.com/services/T0000/B0000/XYZ",
      "12345678: 範例說明文字",
    ].join("\n");
    assert.deepEqual(scanContent(clean), []);
  });

  it("allowlist 可依檔依規則放行", () => {
    const content = "token " + "g".repeat(26) + "." + "h".repeat(7) + "." + "i".repeat(27);
    assert.equal(scanContent(content).length, 1);
    assert.deepEqual(scanContent(content, ["Discord bot token"]), []);
    assert.deepEqual(scanContent(content, ["*"]), []);
  });

  it("二進位內容（含 NUL）直接略過", () => {
    const findings = scanContent("binary" + NUL + "AKIA" + "A".repeat(16));
    assert.deepEqual(findings, []);
  });
});
