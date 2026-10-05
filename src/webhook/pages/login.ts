/* * IM Webhook頁面模板（由 server.ts 拆出，NEXT2 D1）。 */
import { LANGS, LANG_LABELS, tr, type Lang } from "../../i18n.js";
import { page } from "../shell.js";

export function renderLoginHtml(lang: Lang) {
    const shortLabels = { zh: "中", en: "EN", ja: "日" };
    const langMenu = LANGS.map((code) => `<button type="button" class="login-lang-item${code === lang ? " active" : ""}" data-lang="${code}">${LANG_LABELS[code]}</button>`).join("");
    const body = `
<div class="login-center">
  <div class="glass login-card">
    <div class="login-head">
      <h2 class="neon-text">IM Webhook</h2>
      <div class="login-lang" id="login-lang">
        <button type="button" class="login-lang-toggle" id="login-lang-toggle">${shortLabels[lang] || "中"} &#9662;</button>
        <div class="login-lang-menu" id="login-lang-menu" hidden>${langMenu}</div>
      </div>
    </div>
    <div class="sub">${tr(lang, "login_sub")}</div>
    <form id="login-form">
      <input id="login-user" placeholder="${tr(lang, "login_user")}" autocomplete="username" required>
      <input id="login-pass" type="password" placeholder="${tr(lang, "login_pass")}" autocomplete="current-password" required>
      <button type="submit">${tr(lang, "login_submit")}</button>
      <p id="login-msg" class="msg" style="margin:12px 0 0"></p>
    </form>
  </div>
</div>
`;
    const script = `
  (function () {
    function switchLang(code) {
      fetch("/login/language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: code })
      }).then(function () { window.location.reload(); })
        .catch(function () { window.location.reload(); });
    }
    var toggle = $("login-lang-toggle");
    var menu = $("login-lang-menu");
    if (toggle && menu) {
      toggle.addEventListener("click", function (e) {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
      });
      menu.addEventListener("click", function (e) { e.stopPropagation(); });
      document.addEventListener("click", function () { menu.hidden = true; });
    }
    Array.prototype.forEach.call(document.querySelectorAll(".login-lang-item"), function (btn) {
      btn.addEventListener("click", function () { switchLang(btn.getAttribute("data-lang")); });
    });
  })();
  $("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    $("login-msg").textContent = "登入中…";
    fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: $("login-user").value, pass: $("login-pass").value })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok) { window.location.href = "/dashboard"; }
        else { $("login-msg").textContent = "登入失敗：" + (data.error || ""); }
      });
    }).catch(function () { $("login-msg").textContent = "登入失敗"; });
  });
`;
    return page(tr(lang, "title_login"), "", body, script, { showNav: false, showTitle: false, lang });
}
