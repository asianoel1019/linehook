/* * ImHook頁面模板（由 server.ts 拆出，NEXT2 D1）。 */
import { config } from "../../config.js";
import { tr } from "../../i18n.js";
import { page } from "../shell.js";

export function renderMessagesHtml() {
    const body = `
<div class="glass glass-hover msg-page">
<h2 style="margin-top:0" data-i18n="title_messages">訊息/LOG</h2>
<div style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
  <span class="range-chips" id="message-tabs">
    <button type="button" class="active" data-tab="received" data-i18n="tab_received">收到的訊息</button>
    <button type="button" data-tab="syslog" data-i18n="tab_syslog">系統紀錄</button>
  </span>
</div>
<div style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
  <span class="range-chips" id="message-range">
    <button type="button" class="active" data-range="all" data-i18n="lbl_range_all">全部</button>
    <button type="button" data-range="10m" data-i18n="lbl_range_10m">10 分鐘</button>
    <button type="button" data-range="1h" data-i18n="lbl_range_1h">1 小時</button>
    <button type="button" data-range="8h" data-i18n="lbl_range_8h">8 小時</button>
    <button type="button" data-range="1d" data-i18n="lbl_range_1d">1 天</button>
    <button type="button" data-range="custom" data-i18n="lbl_range_custom">自訂區間</button>
  </span>
  <span id="message-custom-range" hidden>
    <label for="message-since" data-i18n="lbl_since" class="msg">起</label>
    <input id="message-since" type="datetime-local" style="width:180px">
    <label for="message-until" data-i18n="lbl_until" class="msg">訖</label>
    <input id="message-until" type="datetime-local" style="width:180px">
  </span>
</div>
<div id="tab-received">
<div style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
  <input id="message-search" data-i18n-ph="ph_search" placeholder="搜尋關鍵字" style="width:220px">
  <input id="message-chat" placeholder="MID" style="width:200px">
  <select id="message-platform" style="width:140px">
    <option value="" data-i18n="opt_all_platforms">全部平台</option>
    <option value="line" data-i18n="platform_line">LINE</option>
    <option value="telegram" data-i18n="platform_telegram">Telegram</option>
    <option value="whatsapp" data-i18n="platform_whatsapp">WhatsApp</option>
    <option value="teams" data-i18n="platform_teams">Teams</option>
    <option value="discord" data-i18n="platform_discord">Discord</option>
  </select>
  <button type="button" id="message-export-json">JSON</button>
  <button type="button" id="message-export-csv">CSV</button>
  <button type="button" id="message-purge" style="color:#fb7185">清除全部</button>
  <span id="message-count" class="msg"></span>
</div>
<table><thead><tr><th data-i18n="th_time">時間</th><th data-i18n="th_source">來源</th><th data-i18n="th_chat">對話</th><th data-i18n="th_content">內容</th></tr></thead><tbody id="messages"></tbody></table>
</div>
<div id="tab-syslog" hidden>
<table><thead><tr><th data-i18n="th_time">時間</th><th data-i18n="th_level">等級</th><th data-i18n="th_message">訊息</th><th data-i18n="th_content">內容</th></tr></thead><tbody id="syslogs"></tbody></table>
</div>
</div>
`;
    const script = `
  var lastMessages = [];
  function render(data) {
    var bodyEl = $("messages");
    var list = data.messages || [];
    lastMessages = list;
    if (list.length === 0) {
      bodyEl.replaceChildren(emptyRow(4));
      $("message-count").textContent = "";
      return;
    }
    $("message-count").textContent = list.length;
    bodyEl.replaceChildren.apply(bodyEl, list.map(function (m) {
      var src = m.fromName ? m.fromName + " (" + m.fromMid + ")" : m.fromMid;
      var chat = m.chatMid;
      if (m.chatType) chat = m.chatType + " " + m.chatMid;
      return tr(td(m.time), td(src), td(chat, "mono"), td(m.text));
    }));
  }

  var RANGE_MS = { "10m": 600000, "1h": 3600000, "8h": 28800000, "1d": 86400000 };
  var rangeMode = "all";

  function currentTimeWindow() {
    var sinceMs = null;
    var untilMs = null;
    if (rangeMode === "custom") {
      var s = $("message-since").value;
      var u = $("message-until").value;
      if (s) { var st = new Date(s).getTime(); if (isFinite(st)) sinceMs = st; }
      if (u) { var ut = new Date(u).getTime(); if (isFinite(ut)) untilMs = ut; }
    } else if (rangeMode !== "all") {
      var ms = RANGE_MS[rangeMode] || 0;
      if (ms) sinceMs = Date.now() - ms;
    }
    return { sinceMs: sinceMs, untilMs: untilMs };
  }

  function queryString() {
    var parts = [];
    var q = $("message-search").value.trim();
    var chat = $("message-chat").value.trim();
    var plat = $("message-platform").value;
    if (q) parts.push("q=" + encodeURIComponent(q));
    if (chat) parts.push("chat=" + encodeURIComponent(chat));
    if (plat) parts.push("chatType=" + encodeURIComponent(plat));
    var w = currentTimeWindow();
    if (w.sinceMs != null) parts.push("sinceTs=" + encodeURIComponent(new Date(w.sinceMs).toISOString()));
    if (w.untilMs != null) parts.push("untilTs=" + encodeURIComponent(new Date(w.untilMs).toISOString()));
    return parts.length > 0 ? "?" + parts.join("&") : "";
  }

  function refresh() {
    fetch("/messages.json" + queryString(), { cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) { window.location.href = "/login"; return null; }
        return res.ok ? res.json() : null;
      })
      .then(function (data) { if (data) render(data); })
      .catch(function () {});
    refreshSyslogs();
  }

  function setMsgTab(tab) {
    document.querySelectorAll("#message-tabs button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === tab);
    });
    $("tab-received").hidden = tab !== "received";
    $("tab-syslog").hidden = tab !== "syslog";
    if (tab === "syslog") refreshSyslogs();
  }
  document.querySelectorAll("#message-tabs button").forEach(function (b) {
    b.addEventListener("click", function () { setMsgTab(b.getAttribute("data-tab")); });
  });

  function refreshSyslogs() {
    fetch("/status.json", { cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) { window.location.href = "/login"; return null; }
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        if (!data) return;
        var w = currentTimeWindow();
        var list = (data.logs || []).filter(function (l) {
          if (w.sinceMs == null && w.untilMs == null) return true;
          var t = Date.parse(l.time || "");
          if (!isFinite(t)) return false;
          if (w.sinceMs != null && t < w.sinceMs) return false;
          if (w.untilMs != null && t > w.untilMs) return false;
          return true;
        }).reverse();
        var bodyEl = $("syslogs");
        if (list.length === 0) {
          bodyEl.replaceChildren(emptyRow(4));
          return;
        }
        bodyEl.replaceChildren.apply(bodyEl, list.map(function (l) {
          return tr(td(l.time), td(l.level, "lv-" + l.level), td(l.message), td(l.meta ? JSON.stringify(l.meta) : "", "mono"));
        }));
      })
      .catch(function () {});
  }

  function download(filename, text, mime) {
    var blob = new Blob(["\uFEFF" + text], { type: mime + ";charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function csvCell(v) {
    var s = String(v == null ? "" : v);
    return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  $("message-export-json").addEventListener("click", function () {
    download("messages.json", JSON.stringify(lastMessages, null, 2), "application/json");
  });
  $("message-export-csv").addEventListener("click", function () {
    var rows = [["time", "fromName", "fromMid", "chatMid", "chatType", "text"]];
    lastMessages.forEach(function (m) {
      rows.push([m.time, m.fromName, m.fromMid, m.chatMid, m.chatType, m.text].map(csvCell));
    });
    download("messages.csv", rows.map(function (r) { return r.join(","); }).join("\\n"), "text/csv");
  });

  $("message-purge").addEventListener("click", function () {
    if (!window.confirm("確定清除全部訊息紀錄（記憶體＋檔案）？此動作無法復原。")) return;
    post("messages/purge", {}).then(function (r) {
      $("message-count").textContent = r.ok
        ? ("已清除（記憶體 " + r.data.memory + " 筆）")
        : ("失敗：" + (r.data.error || ""));
      refresh();
    });
  });

  function setRange(mode) {
    rangeMode = mode;
    document.querySelectorAll("#message-range button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-range") === mode);
    });
    $("message-custom-range").hidden = mode !== "custom";
    refresh();
  }
  document.querySelectorAll("#message-range button").forEach(function (b) {
    b.addEventListener("click", function () { setRange(b.getAttribute("data-range")); });
  });

  var searchTimer = null;
  function scheduleRefresh() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(refresh, 300);
  }
  [$("message-search"), $("message-chat"), $("message-since"), $("message-until")].forEach(function (el) {
    el.addEventListener("input", scheduleRefresh);
  });
  $("message-platform").addEventListener("change", scheduleRefresh);

  refresh();
  setInterval(refresh, 5000);
`;
    return page(tr(config.language, "title_messages"), "messages", body, script);
}
/** 全部支援的平台（含未啟用）；供前端顯示「未啟用」空白狀態。 */
