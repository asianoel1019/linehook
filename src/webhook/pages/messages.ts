/* * IM Webhook頁面模板（由 server.ts 拆出，NEXT2 D1）。 */
import { config } from "../../config.js";
import { tr } from "../../i18n.js";
import { page } from "../shell.js";

export function renderMessagesHtml() {
    const body = `
<div class="glass glass-hover">
<h2 style="margin-top:0" data-i18n="title_messages">收到的訊息</h2>
<div style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
  <input id="message-search" data-i18n-ph="ph_search" placeholder="搜尋關鍵字" style="width:220px">
  <input id="message-chat" placeholder="MID" style="width:200px">
  <button type="button" id="message-export-json">JSON</button>
  <button type="button" id="message-export-csv">CSV</button>
  <button type="button" id="message-purge" style="color:#fb7185">清除全部</button>
  <span id="message-count" class="msg"></span>
</div>
<table><thead><tr><th data-i18n="th_time">時間</th><th data-i18n="th_source">來源</th><th data-i18n="th_chat">對話</th><th data-i18n="th_content">內容</th></tr></thead><tbody id="messages"></tbody></table>
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

  function queryString() {
    var parts = [];
    var q = $("message-search").value.trim();
    var chat = $("message-chat").value.trim();
    if (q) parts.push("q=" + encodeURIComponent(q));
    if (chat) parts.push("chat=" + encodeURIComponent(chat));
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

  var searchTimer = null;
  [$("message-search"), $("message-chat")].forEach(function (el) {
    el.addEventListener("input", function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(refresh, 300);
    });
  });

  refresh();
  setInterval(refresh, 5000);
`;
    return page(tr(config.language, "title_messages"), "messages", body, script);
}
/** 全部支援的平台（含未啟用）；供前端顯示「未啟用」空白狀態。 */
