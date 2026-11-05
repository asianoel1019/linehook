/* 外部推播入口：讓其他專案（CI／監控／自動化）把事件推成 IM 訊息。 */
import { config } from "../../config.js";
import { tr } from "../../i18n.js";
import { listSkills } from "../../skills/index.js";
import { page } from "../shell.js";

const PLATFORMS = ["line", "telegram", "whatsapp", "teams", "discord"];

export function renderHooksHtml() {
  const skillOptions = listSkills()
    .map((s) => ({ id: s.id, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  const body = `
<div class="glass">
  <h2 style="margin-top:0" data-i18n="hooks_title">外部推播入口</h2>
  <div class="hint" data-i18n="hooks_lead">讓其他專案（CI、監控、自動化、居家設備）把事件推成這裡的訊息。呼叫端不需要知道任何 IM 平台的細節。</div>
  <div class="hint" style="margin-top:8px">
    <span data-i18n="hooks_doc_hint">文件：</span>
    <a href="/docs/integration-quickref.md" target="_blank" rel="noopener">integration-quickref.md</a>
    · <a href="/docs/integration.md" target="_blank" rel="noopener">integration.md</a>
  </div>
  <details style="margin-top:10px">
    <summary data-i18n="hooks_contract">對外契約摘要</summary>
    <div class="hint" style="margin-top:8px">
      <code>POST /hook/&lt;名稱&gt;</code>
      <span data-i18n="hooks_contract_hint">（事件 → 依 hook 設定路由／渲染／投遞）</span><br>
      <code>X-Hook-Timestamp</code> / <code>X-Hook-Nonce</code> / <code>X-Hook-Signature</code>
      <span data-i18n="hooks_sign_hint">：簽章＝hex(HMAC-SHA256("{時間戳}.{nonce}.{原始 body}", 金鑰))</span>
    </div>
  </details>
</div>

<div class="glass" style="margin-top:14px">
  <details id="hook-form-box">
    <summary><span id="hook-form-title" data-i18n="hooks_add">新增 hook</span></summary>
    <div style="margin-top:10px">
      <div class="field"><label data-i18n="hooks_name">名稱</label><input id="hk-name" placeholder="ci-failed"><div class="hint" data-i18n="hooks_name_hint">小寫字母、數字、-、_；建立後不可改</div></div>
      <div class="field"><label data-i18n="hooks_desc">說明</label><input id="hk-desc" placeholder="CI 失敗通知"></div>
      <div class="field"><label data-i18n="hooks_platform">平台</label><select id="hk-platform">${PLATFORMS.map((p) => `<option value="${p}">${tr(config.language, `platform_${p}`)}</option>`).join("")}</select></div>
      <div class="field"><label data-i18n="hooks_to">目標對話</label><input id="hk-to" placeholder="工作群"><div class="hint" data-i18n="hooks_to_hint">對話名稱（不是 id）；改名後不用改設定</div></div>
      <div class="field"><label data-i18n="hooks_template">訊息範本</label><input id="hk-template" placeholder="{{repo}} #{{pr}} ❌ {{reason}}"><div class="hint" data-i18n="hooks_template_hint">支援 {{a.b}} 與 {{a.b | upper}}；留空則用事件裡的 text</div></div>
      <div class="field"><label data-i18n="hooks_secret">簽章金鑰</label><input id="hk-secret" placeholder="留空自動產生"><div class="hint" data-i18n="hooks_secret_hint">金鑰只顯示一次，請複製給對方；之後可隨時重新產生</div></div>
      <div class="field"><label data-i18n="hooks_include">降噪：只有包含時才送</label><input id="hk-include" placeholder="failed, timeout"><div class="hint" data-i18n="hooks_include_hint">逗號分隔關鍵字（比對事件的所有欄位）</div></div>
      <div class="field"><label data-i18n="hooks_exclude">降噪：包含就不送</label><input id="hk-exclude" placeholder="draft, wip"></div>
      <div class="field"><label data-i18n="hooks_rate">速率上限（次/分）</label><input id="hk-rate" type="number" min="0" value="30"><div class="hint" data-i18n="hooks_rate_hint">0＝不限；超過會回 429</div></div>
      <div class="field"><label data-i18n="hooks_retries">失敗重試次數</label><input id="hk-retries" type="number" min="0" value="2"><div class="hint" data-i18n="hooks_retries_hint">指數退避；連續失敗 3 次會發告警</div></div>
      <div class="field"><label data-i18n="hooks_skill">觸發技能（選填）</label><select id="hk-skill"><option value="">（不觸發技能，直接用範本）</option>${skillOptions.map((s) => `<option value="${s.id}">${s.name}（${s.id}）</option>`).join("")}</select><div class="hint" data-i18n="hooks_skill_hint">事件 → 跑這支技能 → 用技能輸出推播（不經觸發詞比對）</div></div>
      <div class="field"><label data-i18n="hooks_skill_args">技能參數（選填）</label><input id="hk-skill-args" placeholder="{{city}} 天氣"></div>
      <div class="actions">
        <button type="button" id="hk-save" data-i18n="save_settings">儲存</button>
        <button type="button" id="hk-cancel" data-i18n="btn_cancel">取消</button>
        <span id="hk-msg" class="msg"></span>
      </div>
    </div>
  </details>
</div>

<div class="glass" style="margin-top:14px">
  <details open>
    <summary><span data-i18n="hooks_list">hook 清單</span>（<span id="hook-count">0</span>）</summary>
    <div style="overflow-x:auto;margin-top:8px">
      <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:720px">
        <thead><tr>
          <th data-i18n="hooks_th_name">名稱</th>
          <th data-i18n="hooks_th_target">目標</th>
          <th data-i18n="hooks_th_platform">平台</th>
          <th data-i18n="hooks_th_state">狀態</th>
          <th data-i18n="hooks_th_last">最近投遞</th>
          <th data-i18n="th_actions">操作</th>
        </tr></thead>
        <tbody id="hook-rows"></tbody>
      </table>
    </div>
  </details>
</div>

<div class="glass" style="margin-top:14px">
  <details id="hk-test-box">
    <summary data-i18n="hooks_test">測試（預覽／實際送出）</summary>
    <div style="margin-top:10px">
      <div class="field"><label data-i18n="hooks_test_hook">hook</label><select id="hk-test-name"></select></div>
      <div class="field"><label data-i18n="hooks_test_payload">範例事件（JSON）</label><textarea id="hk-test-payload" rows="5">{"repo":"proj/api","pr":4213,"reason":"3 tests failed"}</textarea></div>
      <div class="actions">
        <button type="button" id="hk-preview" data-i18n="hooks_preview">預覽（不送出）</button>
        <button type="button" id="hk-test-send" style="color:#fb7185" data-i18n="hooks_send">實際送出</button>
        <span id="hk-test-msg" class="msg"></span>
      </div>
      <div id="hk-test-out" class="msg" style="margin-top:8px;white-space:pre-wrap"></div>
      <div class="hint" style="margin-top:6px" data-i18n="hooks_test_hint">「實際送出」會真的送到目標對話，請確認範例內容。</div>
    </div>
  </details>
</div>

<div class="msg" style="margin-top:14px">
  <span data-i18n="hooks_other_sources">其他推播來源：</span>
  <a href="/skills#schedules" data-i18n="hooks_other_sources_link">技能 › 排程中心</a>
  <span data-i18n="hooks_other_sources_hint">（技能自己排的推播）</span>
</div>
`;
  const script = `
  var editing = null;
  var hookRows = [];

  function msg(t) { document.getElementById("hk-msg").textContent = t || ""; }

  function platformLabel(p) { return T("platform_" + p) || p; }

  function fmtTime(ms) {
    try { return new Date(ms).toLocaleString(); } catch (e) { return String(ms); }
  }

  function lastText(h) {
    if (!h.lastDelivery) return "-";
    var d = h.lastDelivery;
    return (d.ok ? "✅ " : "❌ ") + fmtTime(d.at) + (d.error ? "（" + d.error + "）" : "");
  }

  function fillForm(h) {
    document.getElementById("hk-name").value = h ? h.name : "";
    document.getElementById("hk-name").disabled = !!h;
    document.getElementById("hk-desc").value = h ? (h.description || "") : "";
    document.getElementById("hk-platform").value = h ? h.platform : "line";
    document.getElementById("hk-to").value = h ? h.to : "";
    document.getElementById("hk-template").value = h ? (h.template || "") : "";
    document.getElementById("hk-secret").value = "";
    document.getElementById("hk-include").value = h && h.include ? h.include.join(", ") : "";
    document.getElementById("hk-exclude").value = h && h.exclude ? h.exclude.join(", ") : "";
    document.getElementById("hk-rate").value = h && h.ratePerMin !== undefined ? h.ratePerMin : 30;
    document.getElementById("hk-retries").value = h && h.retries !== undefined ? h.retries : 2;
    document.getElementById("hk-skill").value = h ? (h.skill || "") : "";
    document.getElementById("hk-skill-args").value = h ? (h.skillArgs || "") : "";
    document.getElementById("hook-form-title").textContent = h ? T("hooks_edit") : T("hooks_add");
  }

  function openForm(h) {
    editing = h ? h.name : null;
    fillForm(h);
    document.getElementById("hook-form-box").open = true;
    document.getElementById("hook-form-box").scrollIntoView({ block: "nearest" });
  }

  function closeForm() {
    editing = null;
    fillForm(null);
    document.getElementById("hook-form-box").open = false;
  }

  function splitList(v) {
    return String(v || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function collect() {
    var body = {
      name: (document.getElementById("hk-name").value || "").trim(),
      description: (document.getElementById("hk-desc").value || "").trim(),
      platform: document.getElementById("hk-platform").value,
      to: (document.getElementById("hk-to").value || "").trim(),
      template: document.getElementById("hk-template").value,
      include: splitList(document.getElementById("hk-include").value),
      exclude: splitList(document.getElementById("hk-exclude").value),
      ratePerMin: Number(document.getElementById("hk-rate").value || 0),
      retries: Number(document.getElementById("hk-retries").value || 0),
      skill: document.getElementById("hk-skill").value || "",
      skillArgs: document.getElementById("hk-skill-args").value || "",
    };
    var secret = (document.getElementById("hk-secret").value || "").trim();
    if (secret) body.secret = secret;
    return body;
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, data: d }; });
    });
  }

  function render() {
    var tbody = document.getElementById("hook-rows");
    document.getElementById("hook-count").textContent = String(hookRows.length);
    var testSel = document.getElementById("hk-test-name");
    var keepTest = testSel.value;
    testSel.replaceChildren.apply(testSel, hookRows.map(function (h) {
      var o = document.createElement("option");
      o.value = h.name;
      o.textContent = h.name;
      return o;
    }));
    if (keepTest) testSel.value = keepTest;
    tbody.replaceChildren.apply(tbody, hookRows.map(function (h) {
      var tr = document.createElement("tr");
      var c1 = document.createElement("td");
      c1.innerHTML = "";
      var nm = document.createElement("div");
      nm.style.fontWeight = "700";
      nm.textContent = h.name;
      c1.appendChild(nm);
      if (h.description) {
        var ds = document.createElement("div");
        ds.className = "msg";
        ds.style.fontSize = "12px";
        ds.textContent = h.description;
        c1.appendChild(ds);
      }
      var c2 = document.createElement("td");
      c2.textContent = h.to;
      var c3 = document.createElement("td");
      c3.textContent = platformLabel(h.platform);
      var c4 = document.createElement("td");
      var st = document.createElement("span");
      st.className = "badge " + (h.disabled ? "" : "ok");
      st.textContent = h.disabled ? T("hooks_disabled") : T("hooks_enabled");
      c4.appendChild(st);
      if (h.skill) {
        var sk = document.createElement("div");
        sk.className = "msg";
        sk.style.fontSize = "12px";
        sk.textContent = T("hooks_th_skill") + "：" + h.skill;
        c4.appendChild(sk);
      }
      var c5 = document.createElement("td");
      c5.textContent = lastText(h);
      var c6 = document.createElement("td");
      var actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.gap = "6px";
      actions.style.flexWrap = "wrap";
      var bTest = document.createElement("button");
      bTest.type = "button";
      bTest.textContent = T("btn_test");
      bTest.addEventListener("click", function () {
        document.getElementById("hk-test-name").value = h.name;
        var box = document.getElementById("hk-test-box");
        if (box) box.open = true;
        document.getElementById("hk-test-payload").focus();
      });
      var bEdit = document.createElement("button");
      bEdit.type = "button";
      bEdit.textContent = T("btn_edit");
      bEdit.addEventListener("click", function () { openForm(h); });
      var bToggle = document.createElement("button");
      bToggle.type = "button";
      bToggle.textContent = h.disabled ? T("hooks_enable") : T("hooks_disable");
      bToggle.addEventListener("click", function () {
        post("/hooks", Object.assign({}, h, { disabled: !h.disabled })).then(function (r) {
          if (!r.ok) { msg(T("save_failed") + (r.data.error || "")); return; }
          load();
        });
      });
      var bDel = document.createElement("button");
      bDel.type = "button";
      bDel.style.color = "#fb7185";
      bDel.textContent = T("btn_delete");
      bDel.addEventListener("click", function () {
        if (!window.confirm(T("hooks_confirm_delete").replace("{name}", h.name))) return;
        fetch("/hooks/" + encodeURIComponent(h.name), { method: "DELETE" })
          .then(function (res) { return res.json().catch(function () { return {}; }); })
          .then(function () { load(); });
      });
      var bLog = document.createElement("button");
      bLog.type = "button";
      bLog.textContent = T("hooks_deliveries");
      bLog.addEventListener("click", function () { showDeliveries(h.name); });
      actions.append(bTest, bEdit, bToggle, bDel, bLog);
      c6.appendChild(actions);
      tr.append(c1, c2, c3, c4, c5, c6);
      return tr;
    }));
  }

  function showDeliveries(name) {
    fetch("/hooks/" + encodeURIComponent(name) + "/deliveries", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (d) {
        var out = document.getElementById("hk-test-out");
        if (!d) { out.textContent = T("load_failed"); return; }
        var list = d.deliveries || [];
        if (list.length === 0) { out.textContent = T("hooks_no_deliveries"); return; }
        out.textContent = list.map(function (r) {
          return (r.ok ? "✅ " : "❌ ") + r.status + "｜" + fmtTime(r.at) + "｜" + (r.target || "") + (r.error ? "｜" + r.error : "");
        }).join("\\n");
      });
  }

  function load() {
    fetch("/hooks.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (d) {
        if (!d) return;
        hookRows = d.hooks || [];
        render();
      });
  }

  document.getElementById("hk-save").addEventListener("click", function () {
    msg(T("saving"));
    var body = collect();
    if (editing) body.name = editing;
    post("/hooks", body).then(function (r) {
      if (!r.ok) { msg(T("save_failed") + (r.data.error || "")); return; }
      if (r.data.secret) {
        window.alert(T("hooks_secret_once") + "\\n" + r.data.secret + "\\n\\n" + T("hooks_secret_copy_hint"));
      }
      msg(T("saved"));
      closeForm();
      load();
    });
  });

  document.getElementById("hk-cancel").addEventListener("click", closeForm);

  document.getElementById("hk-preview").addEventListener("click", function () {
    var name = document.getElementById("hk-test-name").value;
    var payload;
    try { payload = JSON.parse(document.getElementById("hk-test-payload").value || "{}"); }
    catch (e) {
      document.getElementById("hk-test-msg").textContent = T("hooks_bad_json");
      return;
    }
    fetch("/hooks/" + encodeURIComponent(name) + "/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) { return res.json().catch(function () { return {}; }); })
      .then(function (d) {
        var out = document.getElementById("hk-test-out");
        var lines = [];
        lines.push(T("hooks_preview_would") + "：" + (d.wouldSend ? T("hooks_preview_yes") : T("hooks_preview_no")));
        if (d.reason) lines.push(T("hooks_preview_reason") + "：" + d.reason);
        if (d.rendered) lines.push("──\\n" + d.rendered);
        if (d.skill) lines.push(T("hooks_preview_skill") + "：" + d.skill + "｜" + (d.skillArgs || ""));
        out.textContent = lines.join("\\n");
        document.getElementById("hk-test-msg").textContent = "";
      });
  });

  document.getElementById("hk-test-send").addEventListener("click", function () {
    var name = document.getElementById("hk-test-name").value;
    if (!name) { document.getElementById("hk-test-msg").textContent = T("hooks_pick_first"); return; }
    if (!window.confirm(T("hooks_send_confirm"))) return;
    var payload;
    try { payload = JSON.parse(document.getElementById("hk-test-payload").value || "{}"); }
    catch (e) {
      document.getElementById("hk-test-msg").textContent = T("hooks_bad_json");
      return;
    }
    fetch("/hooks/" + encodeURIComponent(name) + "/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, data: d }; }); })
      .then(function (r) {
        document.getElementById("hk-test-msg").textContent = r.ok ? T("hooks_sent") : (r.data.error || T("send_failed"));
        document.getElementById("hk-test-out").textContent = r.ok && r.data.text ? r.data.text : "";
        load();
      });
  });

  fillForm(null);
  load();
`;
  return page(tr(config.language, "nav_hooks"), "hooks", body, script);
}

export default renderHooksHtml;
