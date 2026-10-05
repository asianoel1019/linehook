/* * IM Webhook頁面模板（由 server.ts 拆出，NEXT2 D1）。 */
import { config } from "../../config.js";
import { tr } from "../../i18n.js";
import { degradedCapabilities } from "../../messaging/capabilities.js";
import { page } from "../shell.js";

/** 各平台非原生能力的提示文字（console 送出前提示用）。 */
function capabilityNotes(): Record<string, string[]> {
    return {
        line: degradedCapabilities("line"),
        telegram: degradedCapabilities("telegram"),
        whatsapp: degradedCapabilities("whatsapp"),
        teams: degradedCapabilities("teams"),
    };
}

export function renderConsoleHtml() {
    const body = `
<div class="fn-panel active" data-fn="test">
<h2 style="margin-top:0" data-i18n="panel_test">測試發送</h2>
<div class="glass glass-hover">
<form id="test-form">
  <div class="field"><label data-i18n="lbl_to">對象</label><input id="test-to" placeholder="好友名稱或 mid" required><div class="hint">發送平台由左側「通訊平台」決定</div><div class="msg" id="capability-hint" style="margin-top:4px"></div></div>
  <div class="field"><label data-i18n="lbl_text">文字</label><input id="test-text" placeholder="訊息內容（可留空）"></div>
  <div class="field"><label data-i18n="lbl_file_path">檔案路徑</label><input id="test-file" placeholder="伺服器上的檔案路徑，例如 /opt/app/quote.pdf"></div>
  <div class="field"><label data-i18n="lbl_image">圖片（URL 或路徑）</label><input id="test-image" placeholder="https://... 或 /opt/app/a.jpg"></div>
  <div class="field"><label data-i18n="lbl_video">影片（URL 或路徑）</label><input id="test-video" placeholder="https://... 或 /opt/app/a.mp4"></div>
  <div class="field"><label data-i18n="lbl_audio">語音（URL 或路徑）</label><input id="test-audio" placeholder="https://... 或 /opt/app/a.m4a"></div>
  <div class="field"><label data-i18n="lbl_display_filename">顯示檔名</label><input id="test-filename" placeholder="選填"></div>
  <details>
    <summary data-i18n="summary_advanced">進階（貼圖 / 位置 / Flex / 延遲）</summary>
    <div class="field"><label data-i18n="lbl_sticker_pkg">貼圖 packageId</label><input id="test-sticker-pkg" placeholder="例如 446"></div>
    <div class="field"><label data-i18n="lbl_sticker_id">貼圖 stickerId</label><input id="test-sticker-id" placeholder="例如 1988"></div>
    <div class="field"><label data-i18n="lbl_loc_title">位置標題</label><input id="test-loc-title" placeholder="選填"></div>
    <div class="field"><label data-i18n="lbl_loc_address">位置地址</label><input id="test-loc-address" placeholder="選填"></div>
    <div class="field"><label data-i18n="lbl_lat_lng">緯度 / 經度</label><span style="display:flex;gap:8px"><input id="test-loc-lat" placeholder="25.033" style="flex:1"><input id="test-loc-lng" placeholder="121.565" style="flex:1"></span></div>
    <div class="field"><label data-i18n="lbl_flex_alt">Flex altText</label><input id="test-flex-alt" placeholder="選填"></div>
    <div class="field"><label data-i18n="lbl_flex_json">Flex JSON</label><textarea id="test-flex-json" placeholder='{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"Hi"}]}}'></textarea></div>
    <div class="field"><label data-i18n="lbl_delay">延遲發送</label><span style="display:flex;gap:8px;align-items:center"><input id="test-delay" type="text" placeholder="秒數（例如 60）或 2026-01-01 09:00:00" style="flex:1;min-width:200px"><input id="test-datetime" type="datetime-local" style="position:absolute;opacity:0;pointer-events:none;width:0;height:0"><button type="button" id="test-datetime-btn" class="icon-btn" title="選擇日期時間">&#128197;</button></span><div class="hint">可填「秒數」或「年月日 時:分:秒」；點日曆圖示選時間會帶入欄位。留空 = 立即發送</div></div>
  </details>
  <div class="field"><label>插入媒體</label><span style="display:flex;gap:8px;flex-wrap:wrap"><input id="test-upload" type="file" style="flex:1"><button type="button" id="test-upload-btn">上傳並填入</button><span id="test-upload-msg" class="msg"></span></span></div>
   <div class="actions"><button type="submit" data-i18n="btn_send">發送</button><span id="test-msg" class="msg"></span></div>
</form>
</div>
</div>

<div class="fn-panel" data-fn="flex-editor" data-im="line">
<h2 style="margin-top:0" data-i18n="panel_flex_editor">Flex 可視化編輯</h2>
<div class="glass">
<div style="display:flex;gap:16px;flex-wrap:wrap">
<div style="flex:1;min-width:260px">
<form id="flex-editor-form">
  <div class="field"><label data-i18n="lbl_flex_alt">Flex altText</label><input id="fx-alt" placeholder="Flex 訊息"></div>
  <div class="field"><label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input id="fx-hero-on" type="checkbox" checked style="width:auto"><span data-i18n="fx_show_hero">顯示主圖</span></label></div>
  <div class="field"><label data-i18n="fx_hero_url">主圖 URL</label><input id="fx-hero-url" placeholder="https://..."></div>
  <div class="field"><label data-i18n="fx_hero_ratio">主圖比例</label><select id="fx-hero-ratio"><option value="20:13">20:13</option><option value="1:1">1:1</option><option value="4:3">4:3</option><option value="16:9">16:9</option></select></div>
  <div class="field"><label data-i18n="fx_title">標題</label><input id="fx-title" placeholder="標題文字"></div>
  <div class="field"><label data-i18n="fx_body">內文</label><textarea id="fx-body" placeholder="內文（換行會保留）"></textarea></div>
  <div class="field"><label data-i18n="fx_buttons">按鈕（最多 3 個）</label><div id="fx-buttons"></div><div class="actions"><button type="button" id="fx-btn-add" data-i18n="fx_btn_add">新增按鈕</button></div></div>
  <div class="actions"><button type="button" id="fx-fill-test" data-i18n="fx_fill_test">填入測試表單</button><button type="button" id="fx-copy" data-i18n="fx_copy">複製 JSON</button><span id="fx-msg" class="msg"></span></div>
</form>
</div>
<div style="flex:1;min-width:260px">
  <div class="field"><label data-i18n="fx_preview">預覽（示意）</label><div id="fx-preview" style="max-width:320px;margin:0 auto"></div></div>
  <div class="field"><label data-i18n="fx_json_out">產生的 Flex JSON</label><textarea id="fx-json" readonly style="min-height:140px"></textarea></div>
</div>
</div>
</div>
</div>

<div class="fn-panel" data-fn="targets-list">
<h2 style="margin-top:0" data-i18n="panel_targets">目標清單</h2>
<div class="glass">
<details id="targets-details" open>
  <summary><span data-i18n="list_count">清單</span>（<span id="target-count">0</span>）</summary>
  <div style="margin:8px 0">
    <input id="target-search" data-i18n-ph="ph_search" placeholder="搜尋名稱或 MID" style="width:280px">
    <span id="target-msg" class="msg"></span>
  </div>
  <table class="targets-table"><thead><tr><th data-i18n="th_name">名稱</th><th>MID</th><th class="th-actions" style="width:180px" data-i18n="th_actions">操作</th></tr></thead><tbody id="targets"></tbody></table>
</details>
</div>
</div>

<div class="fn-panel" data-fn="logs">
<h2 style="margin-top:0" data-i18n="panel_logs">最近紀錄</h2>
<div class="glass">
<details open>
  <summary data-i18n="list_count">清單</summary>
  <table><thead><tr><th data-i18n="th_time">時間</th><th data-i18n="th_level">等級</th><th data-i18n="th_message">訊息</th><th data-i18n="th_content">內容</th></tr></thead><tbody id="logs"></tbody></table>
</details>
</div>
</div>

<div class="fn-panel" data-fn="scheduled">
<h2 style="margin-top:0" data-i18n="panel_scheduled">排程中的訊息</h2>
<div class="glass">
<details open>
  <summary><span data-i18n="list_count">清單</span>（<span id="scheduled-count">0</span>）</summary>
  <table><thead><tr><th data-i18n="th_time">時間</th><th data-i18n="th_target">對象</th><th data-i18n="th_content">內容</th><th data-i18n="th_repeat">重複</th><th style="width:190px" data-i18n="th_actions">操作</th></tr></thead><tbody id="scheduled"></tbody></table>
</details>
</div>
</div>

<div class="fn-panel" data-fn="deadletter">
<h2 style="margin-top:0">死信（發送失敗紀錄）</h2>
<div class="glass">
<details open>
  <summary>清單（<span id="deadletter-count">0</span>）</summary>
  <table><thead><tr><th>時間</th><th>平台</th><th>種類</th><th>對象</th><th>內容</th><th>錯誤</th></tr></thead><tbody id="deadletter"></tbody></table>
</details>
</div>
</div>
`;
    const script = `
  var allTargets = [];
  var currentPlatform = window.LW_PLATFORM || "line";

  // E3：送出前即時提示該平台的降級項目（由後端能力表生成）。
  var CAPABILITY_NOTES = ${JSON.stringify(Object.fromEntries(Object.entries(capabilityNotes())))};

  function paintCapabilityHint() {
    var el = $("capability-hint");
    if (!el) return;
    var notes = CAPABILITY_NOTES[currentPlatform];
    el.textContent = notes && notes.length > 0 ? "⚠ " + notes.join("；") : "";
  }

  function applyConsoleImVisibility(platform) {
    Array.prototype.forEach.call(document.querySelectorAll("[data-im]"), function (el) {
      el.classList.toggle("plat-off", el.getAttribute("data-im") !== platform);
    });
    // 若目前開啟的分頁屬於其他平台（被隱藏），退回「測試發送」。
    var activeCard = document.querySelector(".fn-card.active");
    if (activeCard && activeCard.classList.contains("plat-off")) {
      showSection("test", []);
    }
  }

  window.onPlatformChange = function (platform) {
    currentPlatform = platform;
    applyConsoleImVisibility(platform);
    paintCapabilityHint();
    refreshData();
  };
  applyConsoleImVisibility(currentPlatform);
  paintCapabilityHint();

  function renderTargets() {
    var query = $("target-search").value.trim().toLowerCase();
    var list = allTargets.filter(function (t) {
      if (!query) return true;
      return t.name.toLowerCase().indexOf(query) !== -1 || t.id.toLowerCase().indexOf(query) !== -1;
    });
    var body = $("targets");
    if (list.length === 0) {
      body.replaceChildren(emptyRow(3));
      return;
    }
    body.replaceChildren.apply(body, list.map(function (t) {
      var copyBtn = document.createElement("button");
      copyBtn.textContent = T("btn_copy_mapping");
      copyBtn.addEventListener("click", function () {
        var text = t.name + "=" + t.id;
        copyText(text).then(function (ok) {
          $("target-msg").textContent = ok ? "已複製：" + t.name : "無法自動複製，請手動選取：" + text;
        });
      });
      var testBtn = document.createElement("button");
      testBtn.textContent = T("btn_test");
      testBtn.addEventListener("click", function () {
        $("test-to").value = t.name;
        $("test-to").focus();
        $("target-msg").textContent = "已帶入測試對象：" + t.name;
      });
      var actions = document.createElement("td");
      actions.className = "actions-cell";
      actions.append(copyBtn, testBtn);
      return tr(td(t.name), td(t.id, "mono"), actions);
    }));
  }

  function renderScheduled(jobs) {
    jobs = jobs || [];
    $("scheduled-count").textContent = String(jobs.length);
    var body = $("scheduled");
    if (jobs.length === 0) {
      body.replaceChildren(emptyRow(5));
      return;
    }
    body.replaceChildren.apply(body, jobs.map(function (j) {
      var cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = T("btn_cancel");
      cancel.addEventListener("click", function () {
        post("settings/scheduled/cancel", { id: j.id, platform: currentPlatform }).then(function () { refreshData(); });
      });
      var edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = T("btn_edit_time");
      edit.addEventListener("click", function () {
        var input = window.prompt("幾秒後發送，或輸入時間（例：2026-01-01 09:00:00）", "60");
        if (input === null) return;
        var value = input.trim();
        if (!value) return;
        var body = { id: j.id, platform: currentPlatform };
        if (/^\d+$/.test(value)) body.delaySec = Number(value);
        else body.sendAt = value;
        post("settings/scheduled/update", body).then(function (r) {
          if (!r.ok) alert("失敗：" + (r.data.error || ""));
          refreshData();
        });
      });
      var actions = document.createElement("td");
      actions.className = "actions-cell";
      // A3：失敗保留的任務可一鍵重送（delaySec: 0 立即执行並清除 lastError）。
      if (j.lastError) {
        var retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "重送";
        retry.addEventListener("click", function () {
          post("settings/scheduled/update", { id: j.id, platform: currentPlatform, delaySec: 0 }).then(function (r) {
            if (!r.ok) alert("失敗：" + (r.data.error || ""));
            refreshData();
          });
        });
        actions.append(retry);
      }
      actions.append(edit, cancel);
      var summary = (j.summary || "") + (j.lastError ? "（失敗：" + j.lastError + "）" : "");
      return tr(td(j.runAt), td((j.to || []).join(", ")), td(summary), td(j.repeat || "-"), actions);
    }));
  }

  function renderData(data) {
    $("target-count").textContent = String(data.targets.length);
    allTargets = data.targets;
    renderTargets();
    renderScheduled(data.scheduled);
    renderDeadletter();

    var logs = data.logs.slice().reverse();
    var logBody = $("logs");
    if (logs.length === 0) {
      logBody.replaceChildren(emptyRow(4));
    } else {
      logBody.replaceChildren.apply(logBody, logs.map(function (l) {
        return tr(td(l.time), td(l.level, "lv-" + l.level), td(l.message), td(l.meta ? JSON.stringify(l.meta) : "", "mono"));
      }));
    }
  }

  function renderDeadletter() {
    fetch("/deadletter.json?limit=50", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;
        var list = data.deadletters || [];
        $("deadletter-count").textContent = String(list.length);
        var bodyEl = $("deadletter");
        if (list.length === 0) {
          bodyEl.replaceChildren(emptyRow(6));
          return;
        }
        bodyEl.replaceChildren.apply(bodyEl, list.slice().reverse().map(function (d) {
          return tr(td(d.time), td(d.platform), td(d.kind), td((d.to || []).join(", ")), td(d.summary || ""), td(d.error || ""));
        }));
      })
      .catch(function () {});
  }

  function refreshData() {
    fetch("/status.json?platform=" + encodeURIComponent(currentPlatform), { cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) { window.location.href = "/login"; return null; }
        return res.ok ? res.json() : null;
      })
      .then(function (data) { if (data) renderData(data); })
      .catch(function () {});
  }

  $("target-search").addEventListener("input", renderTargets);

  $("btn-relogin").addEventListener("click", function () {
    $("action-msg").textContent = "重登中…";
    post("settings/relogin").then(function (r) {
      $("action-msg").textContent = r.ok ? "已觸發重新登入" : ("失敗：" + (r.data.error || ""));
    });
  });

  $("btn-refresh").addEventListener("click", function () {
    $("action-msg").textContent = "更新中…";
    post("settings/refresh").then(function (r) {
      $("action-msg").textContent = r.ok ? "聯絡人已更新" : ("失敗：" + (r.data.error || ""));
      refreshData();
    });
  });

  $("test-upload-btn").addEventListener("click", function () {
    var input = $("test-upload");
    if (!input.files || !input.files[0]) { $("test-upload-msg").textContent = "請先選擇檔案"; return; }
    var file = input.files[0];
    $("test-upload-msg").textContent = "上傳中…";
    file.arrayBuffer().then(function (buf) {
      return fetch("/settings/upload", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
        body: buf
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (r) {
      if (!r.ok) { $("test-upload-msg").textContent = "失敗：" + (r.data.error || ""); return; }
      $("test-image").value = r.data.path;
      $("test-filename").value = r.data.filename;
      $("test-upload-msg").textContent = "已上傳（" + r.data.bytes + " bytes）並填入圖片欄位";
    }).catch(function () { $("test-upload-msg").textContent = "上傳失敗"; });
  });

  function pad2(n) { return ("0" + n).slice(-2); }

  function toLocalInput(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate())
      + "T" + pad2(date.getHours()) + ":" + pad2(date.getMinutes());
  }

  function setDelayFromPicker() {
    var v = $("test-datetime").value;
    if (!v) return;
    var d = new Date(v);
    if (isNaN(d.getTime())) return;
    $("test-delay").value = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
      + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  $("test-datetime").addEventListener("change", setDelayFromPicker);
  $("test-datetime-btn").addEventListener("click", function () {
    var input = $("test-datetime");
    if (!input.value) {
      var d = new Date(Date.now() + 60000);
      d.setSeconds(0, 0);
      input.value = toLocalInput(d);
    }
    if (typeof input.showPicker === "function") {
      try { input.showPicker(); return; } catch (e) { /* fall through */ }
    }
    input.style.position = "static";
    input.style.opacity = "1";
    input.style.pointerEvents = "auto";
    input.style.width = "auto";
    input.style.height = "auto";
    input.focus();
    input.click();
  });

  $("test-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var payload = {
      to: $("test-to").value.trim(),
      platform: currentPlatform,
      text: $("test-text").value,
      file: $("test-file").value.trim(),
      image: $("test-image").value.trim(),
      video: $("test-video").value.trim(),
      audio: $("test-audio").value.trim(),
      filename: $("test-filename").value.trim()
    };
    var pkg = $("test-sticker-pkg").value.trim();
    var sid = $("test-sticker-id").value.trim();
    if (pkg && sid) payload.sticker = { packageId: pkg, stickerId: sid };
    var lat = $("test-loc-lat").value.trim();
    var lng = $("test-loc-lng").value.trim();
    if (lat && lng) {
      payload.location = {
        title: $("test-loc-title").value,
        address: $("test-loc-address").value,
        latitude: Number(lat),
        longitude: Number(lng)
      };
    }
    var flexJson = $("test-flex-json").value.trim();
    if (flexJson) {
      payload.flex = {
        altText: $("test-flex-alt").value.trim() || "Flex 訊息",
        contents: flexJson
      };
    }
    var delay = $("test-delay").value.trim();
    if (delay) {
      if (/^\d+$/.test(delay)) {
        payload.delaySec = Number(delay);
      } else {
        payload.sendAt = delay;
      }
    }

    $("test-msg").textContent = "處理中…";
    post("settings/test", payload).then(function (r) {
      if (!r.ok) {
        $("test-msg").textContent = "失敗：" + (r.data.error || "");
        return;
      }
      $("test-msg").textContent = r.data.scheduled ? ("已排程：" + r.data.runAt) : "已送出";
      refreshData();
    });
  });

  /* ---- Flex 可視化編輯器 ---- */
  var FX_DRAFT_KEY = "linehook-flex-draft";

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function addFxButtonRow(btn) {
    btn = btn || {};
    var rows = $("fx-buttons").querySelectorAll(".fx-btn-row");
    if (rows.length >= 3) return;
    var row = document.createElement("div");
    row.className = "fx-btn-row";
    row.style.cssText = "display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap";
    var label = document.createElement("input");
    label.className = "fxb-label";
    label.placeholder = T("fx_btn_label");
    label.value = btn.label || "";
    label.style.flex = "1";
    var action = document.createElement("select");
    action.className = "fxb-action";
    action.style.flex = "0 0 110px";
    [["message", T("fx_action_message")], ["uri", T("fx_action_uri")]].forEach(function (pair) {
      var opt = document.createElement("option");
      opt.value = pair[0];
      opt.textContent = pair[1];
      if ((btn.action || "message") === pair[0]) opt.selected = true;
      action.appendChild(opt);
    });
    var value = document.createElement("input");
    value.className = "fxb-value";
    value.placeholder = T("fx_btn_value");
    value.value = btn.value || "";
    value.style.flex = "2";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = T("btn_delete");
    remove.addEventListener("click", function () { row.remove(); syncFlexEditor(); });
    row.append(label, action, value, remove);
    $("fx-buttons").appendChild(row);
  }

  function collectFxButtons() {
    var out = [];
    Array.prototype.forEach.call($("fx-buttons").querySelectorAll(".fx-btn-row"), function (row) {
      var label = row.querySelector(".fxb-label").value.trim();
      if (!label) return;
      out.push({
        label: label,
        action: row.querySelector(".fxb-action").value,
        value: row.querySelector(".fxb-value").value.trim()
      });
    });
    return out;
  }

  function buildFlex() {
    var bubble = { type: "bubble" };
    var heroUrl = $("fx-hero-url").value.trim();
    if ($("fx-hero-on").checked && heroUrl) {
      bubble.hero = {
        type: "image", url: heroUrl, size: "full",
        aspectRatio: $("fx-hero-ratio").value || "20:13", aspectMode: "cover"
      };
    }
    var bodyContents = [];
    if ($("fx-title").value) {
      bodyContents.push({ type: "text", text: $("fx-title").value, weight: "bold", size: "xl", wrap: true });
    }
    if ($("fx-body").value) {
      bodyContents.push({ type: "text", text: $("fx-body").value, size: "sm", color: "#666666", wrap: true });
    }
    if (bodyContents.length > 0) {
      bubble.body = { type: "box", layout: "vertical", contents: bodyContents };
    }
    var btns = collectFxButtons();
    if (btns.length > 0) {
      bubble.footer = {
        type: "box", layout: "vertical", spacing: "sm", contents: btns.map(function (b, i) {
          var act = b.action === "uri"
            ? { type: "uri", label: b.label, uri: b.value }
            : { type: "message", label: b.label, text: b.value || b.label };
          return { type: "button", style: i === 0 ? "primary" : "link", height: "sm", action: act };
        })
      };
    }
    return bubble;
  }

  function renderFlexPreview(bubble) {
    var host = $("fx-preview");
    host.replaceChildren();
    var hasContent = bubble.hero || bubble.body || bubble.footer;
    if (!hasContent) {
      var empty = document.createElement("div");
      empty.className = "msg";
      empty.textContent = T("fx_preview_empty");
      host.appendChild(empty);
      return false;
    }
    var card = document.createElement("div");
    card.style.cssText = "background:#fff;color:#111;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.35);font-family:-apple-system,'Noto Sans TC',sans-serif";
    if (bubble.hero) {
      var img = document.createElement("img");
      img.src = bubble.hero.url;
      img.alt = "";
      img.style.cssText = "display:block;width:100%;aspect-ratio:" + String(bubble.hero.aspectRatio || "20:13").replace(":", "/") + ";object-fit:cover;background:#eee";
      card.appendChild(img);
    }
    if (bubble.body) {
      var bodyBox = document.createElement("div");
      bodyBox.style.padding = "14px 16px";
      bubble.body.contents.forEach(function (c, i) {
        var p = document.createElement("div");
        p.textContent = c.text;
        p.style.cssText = i === 0 && c.weight === "bold"
          ? "font-size:17px;font-weight:700;margin-bottom:6px;white-space:pre-wrap;word-break:break-word"
          : "font-size:13px;color:#666;margin-top:4px;white-space:pre-wrap;word-break:break-word";
        bodyBox.appendChild(p);
      });
      card.appendChild(bodyBox);
    }
    if (bubble.footer) {
      var foot = document.createElement("div");
      foot.style.padding = "0 10px 12px";
      bubble.footer.contents.forEach(function (b) {
        var a = document.createElement("div");
        a.textContent = (b.action && b.action.label) || "";
        var primary = b.style === "primary";
        a.style.cssText = "text-align:center;font-size:14px;border-radius:8px;padding:9px;margin-top:8px;" +
          (primary ? "background:#242424;color:#fff;" : "border:1px solid #d0d0d0;color:#42659a;");
        foot.appendChild(a);
      });
      card.appendChild(foot);
    }
    host.appendChild(card);
    return true;
  }

  function syncFlexEditor(save) {
    var bubble = buildFlex();
    var ok = renderFlexPreview(bubble);
    $("fx-json").value = ok ? JSON.stringify(bubble, null, 2) : "";
    if (save !== false) {
      try {
        localStorage.setItem(FX_DRAFT_KEY, JSON.stringify({
          alt: $("fx-alt").value,
          heroOn: $("fx-hero-on").checked,
          heroUrl: $("fx-hero-url").value,
          ratio: $("fx-hero-ratio").value,
          title: $("fx-title").value,
          body: $("fx-body").value,
          buttons: collectFxButtons()
        }));
      } catch (e) {}
    }
    return ok;
  }

  function restoreFlexDraft() {
    var draft = null;
    try { draft = JSON.parse(localStorage.getItem(FX_DRAFT_KEY) || "null"); } catch (e) {}
    if (!draft) return;
    if (typeof draft.alt === "string") $("fx-alt").value = draft.alt;
    $("fx-hero-on").checked = draft.heroOn !== false;
    if (typeof draft.heroUrl === "string") $("fx-hero-url").value = draft.heroUrl;
    if (typeof draft.ratio === "string") $("fx-hero-ratio").value = draft.ratio;
    if (typeof draft.title === "string") $("fx-title").value = draft.title;
    if (typeof draft.body === "string") $("fx-body").value = draft.body;
    $("fx-buttons").replaceChildren();
    (Array.isArray(draft.buttons) ? draft.buttons : []).slice(0, 3).forEach(addFxButtonRow);
  }

  $("flex-editor-form").addEventListener("input", function () { syncFlexEditor(); });
  $("flex-editor-form").addEventListener("change", function () { syncFlexEditor(); });
  $("fx-btn-add").addEventListener("click", function () {
    addFxButtonRow();
    var rows = $("fx-buttons").querySelectorAll(".fx-btn-row");
    var last = rows[rows.length - 1];
    if (last) last.querySelector(".fxb-label").focus();
  });
  $("fx-fill-test").addEventListener("click", function () {
    if (!syncFlexEditor()) { $("fx-msg").textContent = T("fx_empty"); return; }
    $("test-flex-alt").value = $("fx-alt").value.trim() || "Flex 訊息";
    $("test-flex-json").value = $("fx-json").value;
    $("fx-msg").textContent = T("fx_filled");
  });
  $("fx-copy").addEventListener("click", function () {
    if (!syncFlexEditor()) { $("fx-msg").textContent = T("fx_empty"); return; }
    copyText($("fx-json").value).then(function (ok) {
      $("fx-msg").textContent = ok ? T("fx_copied") : $("fx-json").value;
    });
  });
  restoreFlexDraft();
  syncFlexEditor(false);

  setupCards([], "test");
  setInterval(refreshData, 10000);
`;
    const sidebar = `
<div class="side-section">${tr(config.language, "section_functions")}</div>
<div class="fn-list">
  <button type="button" class="fn-card active" data-fn="test">${tr(config.language, "card_test")}</button>
  <button type="button" class="fn-card" data-fn="flex-editor" data-im="line">${tr(config.language, "panel_flex_editor")}</button>
  <button type="button" class="fn-card" data-fn="targets-list">${tr(config.language, "card_targets")}</button>
  <button type="button" class="fn-card" data-fn="logs">${tr(config.language, "card_logs")}</button>
  <button type="button" class="fn-card" data-fn="scheduled">${tr(config.language, "card_scheduled")}</button>
  <button type="button" class="fn-card" data-fn="deadletter">死信</button>
</div>
<div class="side-section" data-im="line">${tr(config.language, "section_actions")}</div>
<div class="fn-list" data-im="line">
  <button type="button" class="fn-card" id="btn-relogin">${tr(config.language, "relogin")}</button>
  <button type="button" class="fn-card" id="btn-refresh">${tr(config.language, "refresh_contacts")}</button>
</div>
<p id="action-msg" class="msg" style="align-self:stretch; word-break:break-word; margin:6px 2px 0" data-im="line"></p>`;
    return page(tr(config.language, "title_console"), "console", body, script, { sidebar });
}
