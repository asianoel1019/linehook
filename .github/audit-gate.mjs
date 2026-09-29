// CI audit gate: fail on high/critical vulns except known-unfixable allowlist.
// thrift comes only via @evex/linejs (latest 3.4.2, still depends on thrift);
// npm's suggested "fix" (downgrade linejs to 0.0.2) would break LINE, so allowlist it.
import { execSync } from "node:child_process";

const allowlist = ["ghsa-r67j-r569-jrwp", "ghsa-526f-jxpj-jmg2"];

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
  const fresh = ids.filter((id) => !allowlist.includes(id.toLowerCase()));
  if (fresh.length > 0) bad.push(name + "@" + v.range + " [" + fresh.join(",") + "]");
}

if (bad.length > 0) {
  console.error("Blocked vulnerabilities:\n" + bad.join("\n"));
  process.exit(1);
}
console.log("audit ok");
