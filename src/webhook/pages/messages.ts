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
  <span style="position:relative;display:inline-block">
    <button type="button" id="message-range-btn" data-i18n="lbl_range_all">全部</button>
    <span id="message-range-pop" class="range-pop" hidden>
      <div class="range-pop-head"><span data-i18n="rng_quick">快速選擇</span><span><button type="button" id="range-collapse" class="range-arrow">‹</button><button type="button" id="range-expand" class="range-arrow">›</button></span></div>
      <div class="range-quick-row" id="range-quick-row">
        <select id="range-dir"><option value="last" data-i18n="rng_last">過去</option></select>
        <input id="range-num" type="number" min="1" value="1">
        <select id="range-unit">
          <option value="minute" data-i18n="unit_minute">分鐘</option>
          <option value="hour" selected data-i18n="unit_hour">小時</option>
          <option value="day" data-i18n="unit_day">天</option>
          <option value="week" data-i18n="unit_week">週</option>
        </select>
        <button type="button" id="range-apply" data-i18n="btn_apply">套用</button>
      </div>
      <div class="range-pop-head"><span data-i18n="rng_common">常用</span></div>
      <div class="range-presets">
        <div>
          <button type="button" data-preset="all" data-i18n="lbl_range_all">全部</button>
          <button type="button" data-preset="today" data-i18n="rng_today">今天</button>
          <button type="button" data-preset="week" data-i18n="rng_week">本週</button>
          <button type="button" data-preset="1m" data-i18n="rng_1m">近 1 分鐘</button>
          <button type="button" data-preset="15m" data-i18n="rng_15m">近 15 分鐘</button>
          <button type="button" data-preset="30m" data-i18n="rng_30m">近 30 分鐘</button>
          <button type="button" data-preset="1h" data-i18n="rng_1h">近 1 小時</button>
        </div>
        <div>
          <button type="button" data-preset="24h" data-i18n="rng_24h">近 24 小時</button>
          <button type="button" data-preset="7d" data-i18n="rng_7d">近 7 天</button>
          <button type="button" data-preset="30d" data-i18n="rng_30d">近 30 天</button>
          <button type="button" data-preset="90d" data-i18n="rng_90d">近 90 天</button>
          <button type="button" data-preset="1y" data-i18n="rng_1y">近 1 年</button>
        </div>
      </div>
      <div class="range-pop-head"><span data-i18n="lbl_range_custom">自訂區間</span></div>
      <div class="range-quick-row">
        <label for="message-since" data-i18n="lbl_since" class="msg">起</label>
        <input id="message-since" type="datetime-local" style="width:150px">
        <label for="message-until" data-i18n="lbl_until" class="msg">訖</label>
        <input id="message-until" type="datetime-local" style="width:150px">
        <button type="button" id="range-custom-apply" data-i18n="btn_apply">套用</button>
      </div>
    </span>
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

  var RANGE_PRESETS = {
    "1m": 60000,
    "15m": 900000,
    "30m": 1800000,
    "1h": 3600000,
    "24h": 86400000,
    "7d": 604800000,
    "30d": 2592000000,
    "90d": 7776000000,
    "1y": 31536000000
  };
  var RANGE_PRESET_LABEL = {
    all: "lbl_range_all",
    today: "rng_today",
    week: "rng_week",
    "1m": "rng_1m",
    "15m": "rng_15m",
    "30m": "rng_30m",
    "1h": "rng_1h",
    "24h": "rng_24h",
    "7d": "rng_7d",
    "30d": "rng_30d",
    "90d": "rng_90d",
    "1y": "rng_1y"
  };
  var UNIT_MS = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000 };
  var rangeSpec = { type: "all" };

  function rangeLabel() {
    if (rangeSpec.type === "custom") return T("lbl_range_custom");
    if (rangeSpec.type === "today") return T("rng_today");
    if (rangeSpec.type === "week") return T("rng_week");
    if (rangeSpec.type === "relative") {
      return rangeSpec.presetKey ? T(rangeSpec.presetKey) : T("lbl_range_custom");
    }
    return T("lbl_range_all");
  }

  function paintRangeButton() {
    $("message-range-btn").textContent = rangeLabel();
  }

  function currentTimeWindow() {
    var sinceMs = null;
    var untilMs = null;
    var t = rangeSpec.type;
    if (t === "custom") {
      var s = $("message-since").value;
      var u = $("message-until").value;
      if (s) { var st = new Date(s).getTime(); if (isFinite(st)) sinceMs = st; }
      if (u) { var ut = new Date(u).getTime(); if (isFinite(ut)) untilMs = ut; }
    } else if (t === "relative") {
      if (rangeSpec.ms) sinceMs = Date.now() - rangeSpec.ms;
    } else if (t === "today") {
      var d = new Date();
      d.setHours(0, 0, 0, 0);
      sinceMs = d.getTime();
    } else if (t === "week") {
      var w = new Date();
      w.setHours(0, 0, 0, 0);
      w.setDate(w.getDate() - ((w.getDay() + 6) % 7));
      sinceMs = w.getTime();
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

  function closeRangePop() {
    $("message-range-pop").hidden = true;
  }
  $("message-range-btn").addEventListener("click", function (e) {
    e.stopPropagation();
    var p = $("message-range-pop");
    p.hidden = !p.hidden;
  });
  $("message-range-pop").addEventListener("click", function (e) { e.stopPropagation(); });
  document.addEventListener("click", function () { closeRangePop(); });

  function applyRangeSpec(spec) {
    rangeSpec = spec;
    paintRangeButton();
    closeRangePop();
    refresh();
  }
  document.querySelectorAll("#message-range-pop [data-preset]").forEach(function (b) {
    b.addEventListener("click", function () {
      var key = b.getAttribute("data-preset");
      if (key === "all" || key === "today" || key === "week") {
        applyRangeSpec({ type: key });
      } else if (RANGE_PRESETS[key]) {
        applyRangeSpec({ type: "relative", ms: RANGE_PRESETS[key], presetKey: RANGE_PRESET_LABEL[key] });
      } else {
        applyRangeSpec({ type: "all" });
      }
    });
  });
  $("range-apply").addEventListener("click", function () {
    var n = Math.max(1, Math.floor(Number($("range-num").value) || 1));
    var mult = UNIT_MS[$("range-unit").value] || 3600000;
    applyRangeSpec({ type: "relative", ms: n * mult });
  });
  $("range-custom-apply").addEventListener("click", function () {
    applyRangeSpec({ type: "custom" });
  });
  $("range-collapse").addEventListener("click", function () { $("range-quick-row").hidden = true; });
  $("range-expand").addEventListener("click", function () { $("range-quick-row").hidden = false; });
  paintRangeButton();

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
