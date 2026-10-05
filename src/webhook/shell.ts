/* * IM Webhook頁面模板（由 server.ts 拆出，NEXT2 D1）。 */
import { config } from "../config.js";
import { currentUser } from "../middleware/session.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LANGS, LANG_LABELS, langMap, tr, type Lang } from "../i18n.js";

// IM 平台 icon（icons/<id>.png，去背透明 PNG）→ base64 data URI，讀一次後快取；缺檔回空字串。
const imIconCache = new Map<string, string>();
function imIcon(id: string): string {
    const cached = imIconCache.get(id);
    if (cached !== undefined) return cached;
    try {
        const uri = `data:image/png;base64,${readFileSync(resolve(`./icons/${id}.png`)).toString("base64")}`;
        imIconCache.set(id, uri);
        return uri;
    } catch {
        imIconCache.set(id, "");
        return "";
    }
}
export function page(
    title: string,
    active: string,
    body: string,
    script: string,
    options: { showNav?: boolean; sidebar?: string; showTitle?: boolean; lang?: Lang } = {},
): string {
    const showNav = options.showNav ?? true;
    const showTitle = options.showTitle ?? true;
    const lang = options.lang ?? config.language;
    const nav = [
        ["/dashboard", tr(lang, "nav_dashboard"), "dashboard"],
        ["/console", tr(lang, "nav_console"), "console"],
        ["/skills", tr(lang, "nav_skills"), "skills"],
        ["/settings", tr(lang, "nav_settings"), "settings"],
        ["/messages", tr(lang, "nav_messages"), "messages"],
        ["/readme", tr(lang, "nav_readme"), "readme"],
    ]
        .map(([href, label, key]) => `<a href="${href}" class="${key === active ? "active" : ""}">${label}</a>`)
        .join("");
    const username = currentUser();
    const initial = (username.trim()[0] || "?").toUpperCase();
    const esc = (value: string): string => value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const langSwitcher = showNav
        ? `<div class="lang-dock">
<button type="button" class="lang-toggle" id="lang-toggle">${LANG_LABELS[lang]}</button>
<div class="lang-menu" id="lang-menu" hidden>${LANGS.map((code) => `<button type="button" class="lang-btn${code === lang ? " active" : ""}" data-lang="${code}">${LANG_LABELS[code]}</button>`).join("")}</div>
</div>`
        : "";
    const userDock = showNav
        ? `<div class="user-dock">
<div class="user-countdown" id="user-countdown" title="${esc(tr(lang, "idle_logout"))}">05:00</div>
${langSwitcher}
<button type="button" class="user-avatar" id="user-avatar" title="${esc(username)}">${esc(initial)}</button>
<div class="user-menu" id="user-menu" hidden>
  <button type="button" id="menu-password">${tr(lang, "change_password")}</button>
  <button type="button" id="menu-logout">${tr(lang, "logout")}</button>
</div>
</div>`
        : "";
    const sidebar = showNav
        ? `<aside class="sidebar">
<div class="brand neon-text">IM Webhook</div>
<nav>${nav}</nav>
${options.sidebar ?? ""}
${userDock}
</aside>`
        : "";
    // 右上角全域 IM 切換：所有管理頁共用（localStorage: lw_platform）。
    const imOptions = [
        { id: "line", label: tr(lang, "platform_line"), icon: imIcon("line") },
        { id: "telegram", label: tr(lang, "platform_telegram"), icon: imIcon("telegram") },
        { id: "whatsapp", label: tr(lang, "platform_whatsapp"), icon: imIcon("whatsapp") },
        { id: "teams", label: tr(lang, "platform_teams"), icon: imIcon("teams") },
    ];
    const imSwitch = showNav
        ? `<div class="im-switch" id="im-switch">
<button type="button" class="im-switch-btn" id="im-switch-btn">${imOptions[0].icon ? `<img id="im-switch-icon" class="im-switch-icon" src="${imOptions[0].icon}" alt="">` : `<span class="im-switch-dot"></span>`}<span id="im-switch-label">${esc(imOptions[0].label)}</span></button>
<div class="im-switch-menu" id="im-switch-menu" hidden>
${imOptions.map((p) => `<button type="button" data-platform="${p.id}">${p.icon ? `<img class="im-menu-icon" src="${p.icon}" alt="">` : ""}<span>${esc(p.label)}</span></button>`).join("")}
</div>
</div>`
        : "";
    const imSwitchScript = showNav
        ? `
(function () {
  var KEY = "lw_platform";
  var options = ${JSON.stringify(imOptions.map((p) => ({ id: p.id, label: p.label })))};
  var ids = options.map(function (o) { return o.id; });
  var labelOf = {};
  options.forEach(function (o) { labelOf[o.id] = o.label; });
  var current = null;
  try { current = localStorage.getItem(KEY); } catch (e) {}
  if (ids.indexOf(current) === -1) current = ids[0];
  window.LW_PLATFORM = current;
  function paint() {
    var label = document.getElementById("im-switch-label");
    if (label) label.textContent = labelOf[current] || current;
    var btnIcon = document.getElementById("im-switch-icon");
    var activeImg = document.querySelector('#im-switch-menu button[data-platform="' + current + '"] img');
    if (btnIcon && activeImg) btnIcon.src = activeImg.src;
    document.querySelectorAll("#im-switch-menu button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-platform") === current);
    });
  }
  paint();
  if (typeof window.onPlatformChange === "function") window.onPlatformChange(current);
  var btn = document.getElementById("im-switch-btn");
  var menu = document.getElementById("im-switch-menu");
  if (btn && menu) {
    btn.addEventListener("click", function (e) { e.stopPropagation(); menu.hidden = !menu.hidden; });
    menu.addEventListener("click", function (e) { e.stopPropagation(); });
    document.addEventListener("click", function () { menu.hidden = true; });
    menu.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        current = b.getAttribute("data-platform");
        try { localStorage.setItem(KEY, current); } catch (e) {}
        window.LW_PLATFORM = current;
        paint();
        menu.hidden = true;
        if (typeof window.onPlatformChange === "function") window.onPlatformChange(current);
      });
    });
  }
})();
`
        : "";
    const modal = showNav
        ? `<div class="modal-backdrop" id="password-modal" hidden>
<div class="glass modal">
  <h2 style="margin-top:0">${tr(lang, "change_password")}</h2>
  <div class="field"><label>${tr(lang, "pw_current")}</label><input id="pw-current" type="password" autocomplete="current-password"></div>
  <div class="field"><label>${tr(lang, "pw_new")}</label><input id="pw-new" type="password" autocomplete="new-password"></div>
  <div class="field"><label>${tr(lang, "pw_confirm")}</label><input id="pw-confirm" type="password" autocomplete="new-password"></div>
  <p id="pw-msg" class="msg"></p>
  <div class="actions"><button type="button" id="pw-cancel">${tr(lang, "pw_cancel")}</button><button type="button" id="pw-save">${tr(lang, "pw_save")}</button></div>
</div>
</div>`
        : "";
    const dictJson = JSON.stringify(langMap(lang)).replace(/</g, "\\u003c");
    return `<!doctype html>
<html lang="${lang === "zh" ? "zh-Hant" : lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IM Webhook</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<div class="geo geo-circle"></div>
<div class="geo geo-square"></div>
<div class="geo geo-ring"></div>
<div class="shell${showNav ? "" : " solo"}">
${sidebar}
<main class="content">
${imSwitch}
${showTitle ? `<h1 class="neon-text">${title}</h1>` : ""}
${body}
</main>
</div>
${modal}
<script src="/static/js/helpers.js"></script>
<script src="/static/js/session.js"></script>
${showNav ? '<script src="/static/js/user.js"></script>' : ""}
<script>
var __LANG = ${JSON.stringify(lang)};
var __DICT = ${dictJson};
function T(k) { return (__DICT && __DICT[k]) || k; }
function applyI18n() {
  Array.prototype.forEach.call(document.querySelectorAll("[data-i18n]"), function (el) {
    var k = el.getAttribute("data-i18n");
    if (__DICT && __DICT[k]) el.textContent = __DICT[k];
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-ph]"), function (el) {
    var k = el.getAttribute("data-i18n-ph");
    if (__DICT && __DICT[k]) el.placeholder = __DICT[k];
  });
}
${script}
${imSwitchScript}
applyI18n();
</script>
</body>
</html>`;
}
