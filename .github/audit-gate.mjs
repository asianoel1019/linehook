// CI audit gate: fail on high/critical vulns except a *time-boxed* allowlist.
// J4：豁免必須有 reviewedAt / expires / reason；過期或缺欄位一律視為未豁免，
// 讓「暫時容忍」不會變成「永久忽略」。
import { execSync } from "node:child_process";

const TODAY = new Date().toISOString().slice(0, 10);
const SOON_DAYS = 30;

const allowlist = [
  {
    id: "ghsa-r67j-r569-jrwp",
    reviewedAt: "2026-10-02",
    expires: "2027-04-02",
    reason: "thrift 只經 @evex/linejs@3.4.2 可達；npm 建議的修法（降級 linejs 到 0.0.2）會壞掉 LINE",
  },
  {
    id: "ghsa-526f-jxpj-jmg2",
    reviewedAt: "2026-10-02",
    expires: "2027-04-02",
    reason: "同上（thrift 鏈）",
  },
];

let out = "";
try {
  // 字串形式一定走 shell（Windows 上 npm 是 .cmd，需要 shell 才能執行）
  out = execSync("npm audit --json", { encoding: "utf8" });
} catch (e) {
  // 有漏洞時 npm audit 回傳非零結束碼，報告仍在 stdout
  out = (e && e.stdout) || "";
}

let report;
try {
  report = JSON.parse(out || "{}");
} catch {
  console.error("Could not parse npm audit output");
  process.exit(1);
}

function activeExemption(id) {
  const entry = allowlist.find((a) => a.id.toLowerCase() === id);
  if (!entry) return { ok: false, why: "不在豁免清單" };
  if (!entry.expires || !entry.reviewedAt) {
    return { ok: false, why: "豁免缺少 reviewedAt/expires 欄位" };
  }
  if (entry.expires < TODAY) {
    return { ok: false, why: `豁免已於 ${entry.expires} 過期（${entry.reason}）` };
  }
  const daysLeft = Math.round((Date.parse(entry.expires) - Date.parse(TODAY)) / 86400000);
  if (daysLeft <= SOON_DAYS) {
    console.warn(`warn: allowlist ${entry.id} 將於 ${entry.expires} 過期（${daysLeft} 天）`);
  }
  return { ok: true, entry };
}

const bad = [];
const vulns = report.vulnerabilities || {};
for (const name of Object.keys(vulns)) {
  const v = vulns[name];
  if (v.severity !== "high" && v.severity !== "critical") continue;
  const ids = (v.via || [])
    .filter((x) => typeof x === "object" && x.url)
    .map((x) => {
      const m = x.url.match(/GHSA-[a-z0-9-]+/i);
      return m ? m[0] : null;
    })
    .filter(Boolean);
  // via entries that are all plain strings are just transitive pointers;
  // the real advisory has its own entry with a URL
  if (ids.length === 0) continue;
  for (const id of ids) {
    const res = activeExemption(id.toLowerCase());
    if (!res.ok) bad.push(`${name}@${v.range} [${id}] ${res.why}`);
  }
}

if (bad.length > 0) {
  console.error("Blocked vulnerabilities:\n" + bad.join("\n"));
  process.exit(1);
}
console.log("audit ok");
