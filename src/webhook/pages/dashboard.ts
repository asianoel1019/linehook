/* * IM Webhook頁面模板（由 server.ts 拆出，NEXT2 D1）。 */
import { config } from "../../config.js";
import { tr } from "../../i18n.js";
import { page } from "../shell.js";

export function renderDashboardHtml() {
    const body = `
<div><span id="badge" class="badge">-</span></div>
<div id="platforms" class="platform-chips" style="margin-top:10px"></div>
<div id="qrbox" style="display:none">
  <p><b id="qr-hint"></b></p>
  <img id="qrimg" alt="QR" style="width:280px;height:280px;background:#fff;border:1px solid #ddd;padding:8px">
  <div id="qrlink" class="msg"></div>
</div>
<div id="verify"></div>
<div id="platform-blocks"></div>
<div class="glass" id="llm-card" style="display:none">
  <h2 style="margin-top:0" data-i18n="llm_usage_title">LLM 用量（費用估算）</h2>
  <table><thead><tr><th data-i18n="llm_th_skill">技能</th><th data-i18n="llm_th_model">模型</th><th data-i18n="llm_th_tokens">Tokens</th><th data-i18n="llm_th_calls">次數</th><th data-i18n="llm_th_cost">估算費用</th></tr></thead><tbody id="llm-rows"></tbody></table>
  <div class="msg" id="llm-total"></div>
</div>

<div class="dash-grid">
  <div class="glass">
    <h2 style="margin-top:0" data-i18n="recent_title">最近發送 / 紀錄</h2>
    <table class="logs-table"><thead><tr><th>時間</th><th>等級</th><th>訊息</th></tr></thead><tbody id="logs"></tbody></table>
  </div>
</div>
`;
    const script = `
  var qrBox = $("qrbox");
  var qrImg = $("qrimg");
  var qrLink = $("qrlink");
  var lastQr = "";
  var dashPlatform = window.LW_PLATFORM || "line";

  function platformLabel(p) { return T("platform_" + p) || p; }

  function summaryRows(state, queue) {
    return [
      [T("sum_status"), state.status || "-"],
      [T("sum_queue"), String(queue.pending) + (queue.running ? "（" + T("sending") + "）" : "")],
      [T("sum_last_send"), state.lastSendAt || "-"],
      [T("sum_last_to"), state.lastSendTo || "-"],
      [T("sum_last_error"), state.lastError || "-"]
    ];
  }

  function renderChart(host, days) {
    var max = 1;
    days.forEach(function (d) { if (d.total > max) max = d.total; });
    host.replaceChildren.apply(host, days.map(function (d) {
      var col = document.createElement("div");
      col.className = "chart-col";
      col.title = d.date + "：成功 " + d.ok + " / 失敗 " + d.fail;
      var okBar = document.createElement("div");
      okBar.className = "chart-bar ok";
      okBar.style.height = (d.total ? Math.max(3, Math.round((d.ok / max) * 100)) : 0) + "%";
      var failBar = document.createElement("div");
      failBar.className = "chart-bar fail";
      failBar.style.height = (d.total ? Math.max(0, Math.round((d.fail / max) * 100)) : 0) + "%";
      var stack = document.createElement("div");
      stack.className = "chart-stack";
      stack.append(failBar, okBar);
      var label = document.createElement("div");
      label.className = "chart-label";
      label.textContent = d.date.slice(5);
      col.append(stack, label);
      return col;
    }));
  }

  function renderPlatformBlock(p, data) {
    var wrap = document.createElement("div");
    wrap.className = "glass";
    wrap.style.marginTop = "14px";
    wrap.setAttribute("data-platform", p.platform);

    var h = document.createElement("h2");
    h.style.marginTop = "0";
    h.textContent = platformLabel(p.platform);
    wrap.appendChild(h);

    // 狀態摘要
    var sumHost = document.createElement("table");
    sumHost.className = "kv";
    var tb = document.createElement("tbody");
    var s = data.state;
    summaryRows(Object.assign({}, s, { status: p.status || s.status }), p.queue).forEach(function (pair) {
      var th = document.createElement("th");
      th.textContent = pair[0];
      tb.appendChild(tr(th, td(pair[1])));
    });
    sumHost.appendChild(tb);
    wrap.appendChild(sumHost);

    // 發送統計
    var stats = (data.statsByPlatform && data.statsByPlatform[p.platform]) || { total: 0, ok: 0, fail: 0, successRate: 0, byType: {}, days: [] };
    var cards = document.createElement("div");
    cards.className = "stat-cards";
    cards.style.marginTop = "12px";
    [[T("stat_total"), stats.total], [T("stat_ok"), stats.ok], [T("stat_fail"), stats.fail], [T("stat_rate"), stats.successRate + "%"]].forEach(function (c) {
      var card = document.createElement("div");
      card.className = "stat-card";
      var num = document.createElement("div");
      num.className = "stat-num";
      num.textContent = String(c[1]);
      var lbl = document.createElement("div");
      lbl.className = "stat-label";
      lbl.textContent = c[0];
      card.append(num, lbl);
      cards.appendChild(card);
    });
    wrap.appendChild(cards);

    var chart = document.createElement("div");
    chart.className = "chart";
    renderChart(chart, stats.days || []);
    wrap.appendChild(chart);

    var types = Object.keys(stats.byType || {}).map(function (k) { return k + "：" + stats.byType[k]; });
    var typeLine = document.createElement("div");
    typeLine.className = "msg";
    typeLine.style.marginTop = "10px";
    typeLine.textContent = types.length ? T("type_label") + " " + types.join("、") : T("no_send_records");
    wrap.appendChild(typeLine);

    return wrap;
  }

  function renderChips(platforms) {
    var host = $("platforms");
    // 只顯示目前選取平台的 chip；未啟用則不顯示任何 chip。
    var shown = platforms.filter(function (p) { return p.platform === dashPlatform; });
    host.replaceChildren.apply(host, shown.map(function (p) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "active";
      b.textContent = platformLabel(p.platform) + "（目標 " + p.targets + "、佇列 " + p.queue.pending + (p.queue.running ? " 傳送中" : "") + "）";
      return b;
    }));
  }

  function render(data) {
    var s = data.state;
    var platforms = data.platforms || [];
    // 目前選取的平台；若未註冊（停用）則為 null，絕不回退顯示其他平台的資訊。
    var sel = platforms.filter(function (p) { return p.platform === dashPlatform; })[0] || null;
    var active = !!sel;

    var badge = $("badge");
    var selStatus = active ? (sel.status || s.status) : "未啟用";
    badge.textContent = selStatus;
    badge.className = "badge " + (active && selStatus === "已登入" ? "ok" : (active && (selStatus === "待驗證" || selStatus === "需人工") ? "bad" : "warn"));

    // QR：依選取平台顯示（LINE 用 global qrUrl；WhatsApp Web 由服務提供）。
    var verify = $("verify");
    verify.replaceChildren();
    var qrHint = $("qr-hint");
    if (active && sel.qr) {
      qrBox.style.display = "block";
      var thisQr = sel.platform + ":" + dashPlatform;
      if (thisQr !== lastQr) {
        lastQr = thisQr;
        qrImg.src = "/status/qr?platform=" + encodeURIComponent(sel.platform) + "&t=" + Date.now();
      }
      qrHint.textContent = sel.platform === "whatsapp"
        ? "請用手機 WhatsApp「設定 → 已連結的裝置 → 連結裝置」掃描："
        : "請用手機 LINE 的掃描功能掃描：";
      if (sel.platform === "line" && s.qrUrl) {
        var a = document.createElement("a");
        a.href = s.qrUrl;
        a.textContent = "或點此在手機開啟驗證連結";
        a.target = "_blank";
        qrLink.replaceChildren(a);
      } else {
        qrLink.replaceChildren();
      }
    } else {
      qrBox.style.display = "none";
      lastQr = "";
    }
    if (active && sel.platform === "line" && s.pin) {
      var p = document.createElement("p");
      var b = document.createElement("b");
      b.textContent = "PIN 驗證碼：";
      var code = document.createElement("code");
      code.textContent = s.pin;
      p.append(b, code);
      verify.appendChild(p);
    }

    renderChips(platforms);

    var blocks = $("platform-blocks");
    if (active) {
      blocks.replaceChildren(renderPlatformBlock(sel, data));
    } else {
      var empty = document.createElement("div");
      empty.className = "glass";
      empty.style.marginTop = "14px";
      var h = document.createElement("h2");
      h.style.marginTop = "0";
      h.textContent = platformLabel(dashPlatform);
      var msg = document.createElement("div");
      msg.className = "msg";
      msg.textContent = T("platform_not_enabled");
      empty.append(h, msg);
      blocks.replaceChildren(empty);
    }

    var logs = (data.logs || []).slice(-12).reverse();
    var logBody = $("logs");
    if (logs.length === 0) {
      logBody.replaceChildren(emptyRow(3));
    } else {
      logBody.replaceChildren.apply(logBody, logs.map(function (l) {
        return tr(td(l.time), td(l.level, "lv-" + l.level), td(l.message));
      }));
    }
  }

  window.onPlatformChange = function (platform) {
    dashPlatform = platform;
    refresh();
  };

  // K5：LLM 用量與費用估算（全域，不隨平台切換）。
  function renderLlm() {
    fetch("/llm/usage.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (d) {
        var card = $("llm-card");
        if (!d || !d.rows || d.rows.length === 0) { if (card) card.style.display = "none"; return; }
        card.style.display = "block";
        var bodyEl = $("llm-rows");
        bodyEl.replaceChildren.apply(bodyEl, d.rows.map(function (r) {
          var tokens = r.promptTokens + r.completionTokens;
          var cost = r.costUsd === null ? "—" : ("$" + r.costUsd.toFixed(4));
          return tr(td(r.skill), td(r.model, "mono"), td(String(tokens)), td(String(r.calls)), td(cost));
        }));
        var total = $("llm-total");
        total.textContent = T("llm_usage_total")
          + " " + d.totalTokens + " tokens"
          + (d.totalCostUsd !== null ? (" ≈ $" + d.totalCostUsd.toFixed(4)) : "（未列價模型不估算）");
      })
      .catch(function () {});
  }

  function refresh() {
    fetch("/dashboard.json?platform=" + encodeURIComponent(dashPlatform), { cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) { window.location.href = "/login"; return null; }
        return res.ok ? res.json() : null;
      })
      .then(function (data) { if (data) render(data); })
      .catch(function () {});
    renderLlm();
  }

  refresh();
  setInterval(refresh, 5000);
`;
    return page(tr(config.language, "title_dashboard"), "dashboard", body, script);
}
