/* * ImHook頁面模板（由 server.ts 拆出，NEXT2 D1）。 */
import { config } from "../../config.js";
import { tr } from "../../i18n.js";
import { listSkills } from "../../skills/index.js";
import { findTriggerConflicts } from "../../messaging/dispatch.js";
import { resolveText } from "../../skills/types.js";
import { schedulesTabBody, schedulesTabScript } from "./schedules.js";
import { page } from "../shell.js";

export function renderSkillsHtml() {
    const skillDefs = listSkills().map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: resolveText(skill.description, config.language),
        category: resolveText(skill.category, config.language),
        categoryZh: resolveText(skill.category, "zh"),
        defaultTrigger: skill.defaultTrigger,
        triggerMode: skill.triggerMode ?? "assistant",
        hideTrigger: skill.hideTrigger ?? false,
        fields: skill.fields.map((f) => ({
            ...f,
            label: resolveText(f.label, config.language),
            hint: f.hint === undefined ? undefined : resolveText(f.hint, config.language),
        })),
        ruleFields: (skill.ruleFields ?? []).map((f) => ({
            ...f,
            label: resolveText(f.label, config.language),
            hint: f.hint === undefined ? undefined : resolveText(f.hint, config.language),
        })),
        ruleKey: skill.ruleKey ?? "rules",
    }));
    // 觸發詞衝突偵測：只看已啟用技能的有效觸發詞（自訂覆寫優先）＋別名
    const conflictsBySkill: Record<string, Array<{ word: string; kind: string; others: string[] }>> = {};
    {
      const input = listSkills()
        .filter((def) => def.triggerMode !== "any")
        .map((def) => {
          const entry = config.skills.find((s) => s.id === def.id);
          return {
            id: def.id,
            enabled: entry?.enabled ?? false,
            words: [(entry?.trigger || def.defaultTrigger).trim(), ...(def.triggerAliases ?? [])],
          };
        });
      for (const c of findTriggerConflicts(input)) {
        for (const owner of c.owners) {
          const list = conflictsBySkill[owner] ?? [];
          list.push({ word: c.word, kind: c.kind, others: c.owners.filter((o) => o !== owner) });
          conflictsBySkill[owner] = list;
        }
      }
    }
    const skillConflicts = conflictsBySkill;
    const sidebar = `
<div class="side-section">${tr(config.language, "nav_skills")}</div>
<div class="fn-list" id="skills-subnav">
  <button type="button" class="fn-card active" data-tab="list" data-i18n="tab_skill_list">技能列</button>
  <button type="button" class="fn-card" data-tab="install" data-i18n="tab_skill_install">安裝/移除</button>
  <button type="button" class="fn-card" data-tab="ai" data-i18n="tab_skill_ai">AI 設定</button>
  <button type="button" class="fn-card" data-tab="schedules" data-i18n="nav_schedules">排程中心</button>
</div>`;
    const body = `
<div id="tab-list" class="skills-tab">
<div class="glass">
  <div class="field"><label data-i18n="lbl_assistant_enabled">啟用助理</label><input id="assistant-enabled" type="checkbox"><div class="hint" data-i18n="hint_assistant">開啟後，訊息以「名稱」開頭即會呼叫技能，例如「阿寶請幫忙 火車 台北 到 高雄」</div></div>
  <div class="field"><label data-i18n="lbl_assistant_name">助理名稱</label><input id="assistant-name" type="text" placeholder="阿寶"></div>
  <div class="actions"><button type="button" id="skills-save" data-i18n="save_settings">儲存</button><span id="skills-msg" class="msg"></span></div>
</div>
<div style="margin:10px 0 6px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><input id="skill-filter" data-i18n-ph="ph_filter_skills" placeholder="快速篩選：名稱、ID、觸發詞、說明…" style="width:100%;max-width:460px"><label style="display:flex;align-items:center;gap:6px;white-space:nowrap;cursor:pointer"><input id="skill-filter-disabled" type="checkbox"><span data-i18n="lbl_disabled_only">只看未啟用</span></label><label style="display:flex;align-items:center;gap:6px;white-space:nowrap;cursor:pointer"><span data-i18n="lbl_sort">排序</span><select id="skill-sort"></select></label></div>
<div id="skillList"></div>
</div>

<div id="tab-install" class="skills-tab" hidden>
<div class="glass">
  <div class="field"><label data-i18n="lbl_install_skill">安裝技能（上傳 .zip）</label><span style="display:flex;gap:8px;align-items:center"><input id="skill-zip" type="file" accept=".zip,application/zip" style="flex:1"><button type="button" id="skill-install-btn" data-i18n="btn_install">安裝</button><span id="install-msg" class="msg"></span></span><div class="hint" data-i18n="hint_install">zip 內含技能的 index.js（可含 skill.json）。安裝後立即生效。</div><div class="hint"><a href="/library/" target="_blank" rel="noopener" data-i18n="lbl_skill_library">前往技能庫下載</a>：<span data-i18n="hint_library">下載技能 zip 後，回到「技能」頁上傳安裝即可使用。</span></div></div>
  <h2 data-i18n="tab_skill_install">安裝/移除</h2>
  <div style="margin:10px 0 6px"><input id="manage-filter" data-i18n-ph="ph_filter_skills" placeholder="快速篩選：名稱、ID、觸發詞、說明…" style="width:100%;max-width:460px"></div>
  <div id="installed-list"></div>
  <h2 data-i18n="lbl_hidden_skills">已隱藏技能</h2>
  <div id="hidden-list"></div>
</div>
</div>

<div id="tab-ai" class="skills-tab" hidden>
<div class="glass">
  <h2 style="margin-top:0" data-i18n="tab_skill_ai">AI 設定</h2>
  <div class="hint" data-i18n="hint_global_llm">全域 LLM 設定。技能可留空欄位以使用此設定；技能有填寫則以技能為主。</div>
  <div class="field"><label>Provider</label><select id="ai-provider" class="sf"><option value="openai">OpenAI</option><option value="gemini">Gemini（API Key）</option><option value="gemini-cli">Antigravity CLI（帳戶登入）</option><option value="opencode">OpenCode</option><option value="opencode-cli">OpenCode CLI（本機登入）</option><option value="local">本地自建</option><option value="custom">自訂端點</option></select></div>
  <div class="field"><label>Base URL</label><input id="ai-baseUrl" type="text" placeholder="留空用各供應商預設"></div>
  <div class="field"><label>API Key</label><input id="ai-apiKey" type="password" placeholder="CLI 模式／本地自建可留空"></div>
  <div class="field"><label>Model</label><span style="display:flex;gap:8px;align-items:center"><input id="ai-model" type="text" placeholder="留空用預設" style="flex:1" list="ai-models-list"><button type="button" id="ai-models-btn" data-i18n="btn_list_models">列出模型</button><span id="ai-models-msg" class="msg"></span></span><datalist id="ai-models-list"></datalist><div class="hint">opencode-cli 等 CLI 模式：填 provider/model 形式才會鎖定模型（如 opencode/muse-spark-1.3），只填裸 id 會沿用 CLI 自己的預設</div></div>
  <div class="field"><label>System Prompt</label><textarea id="ai-systemPrompt" placeholder="選填"></textarea></div>
  <div class="field"><label>Temperature</label><input id="ai-temperature" type="text" placeholder="0.7"></div>
  <div class="field"><label>Max Tokens</label><input id="ai-maxTokens" type="text" placeholder="2048"></div>
  <div class="field"><label>Timeout (ms)</label><input id="ai-timeoutMs" type="text" placeholder="30000"></div>
  <div class="actions"><button type="button" id="ai-save" data-i18n="save_settings">儲存 AI 設定</button><span id="ai-msg" class="msg"></span></div>
</div>
</div>

<div id="tab-schedules" class="skills-tab" hidden>
${schedulesTabBody()}
</div>
`;
    const script = `
  var SKILL_DEFS = ${JSON.stringify(skillDefs).replace(/</g, "\\u003c")};
  var SKILL_CONFLICTS = ${JSON.stringify(skillConflicts).replace(/</g, "\\u003c")};

  // Tab switching
  document.querySelectorAll("#skills-subnav .fn-card").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#skills-subnav .fn-card").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      var tab = btn.getAttribute("data-tab");
      document.querySelectorAll(".skills-tab").forEach(function (el) { el.hidden = true; });
      var target = document.getElementById("tab-" + tab);
      if (target) target.hidden = false;
      try { history.replaceState(null, "", "#" + tab); } catch (e) {}
      // 排程頁籤每次切入都重抓（30 秒輪詢照跑，這裡保證切入即新鮮）。
      if (tab === "schedules" && typeof schLoad === "function") schLoad();
    });
  });

  // AI global settings
  function loadAiSettings() {
    fetch("/settings.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (s) {
        if (!s) return;
        var g = s.globalLlm || {};
        $("ai-provider").value = g.provider || "openai";
        $("ai-baseUrl").value = g.baseUrl || "";
        $("ai-apiKey").value = g.apiKey || "";
        $("ai-model").value = g.model || "";
        $("ai-systemPrompt").value = g.systemPrompt || "";
        $("ai-temperature").value = g.temperature != null ? String(g.temperature) : "";
        $("ai-maxTokens").value = g.maxTokens != null ? String(g.maxTokens) : "";
        $("ai-timeoutMs").value = g.timeoutMs != null ? String(g.timeoutMs) : "";
      })
      .catch(function () {});
  }

  $("ai-models-btn").addEventListener("click", function () {
    var msg = $("ai-models-msg");
    msg.textContent = "…";
    var cfg = {
      provider: $("ai-provider").value,
      baseUrl: $("ai-baseUrl").value.trim(),
      apiKey: $("ai-apiKey").value.trim(),
      model: $("ai-model").value.trim()
    };
    fetch("/skills/llm/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; });
    }).then(function (r) {
      if (!r.ok) { msg.textContent = "失敗：" + (r.data.error || ""); return; }
      var dl = $("ai-models-list");
      dl.replaceChildren.apply(dl, (r.data.models || []).map(function (m) {
        var o = document.createElement("option");
        o.value = m;
        return o;
      }));
      msg.textContent = "共 " + (r.data.models || []).length + " 個（點輸入框下拉選擇）";
    }).catch(function () { msg.textContent = "讀取失敗"; });
  });

  $("ai-save").addEventListener("click", function () {
    $("ai-msg").textContent = "儲存中…";
    var payload = {
      globalLlm: {
        provider: $("ai-provider").value,
        baseUrl: $("ai-baseUrl").value.trim(),
        apiKey: $("ai-apiKey").value.trim(),
        model: $("ai-model").value.trim(),
        systemPrompt: $("ai-systemPrompt").value.trim(),
        temperature: Number($("ai-temperature").value) || 0.7,
        maxTokens: Math.max(1, Number($("ai-maxTokens").value) || 2048),
        timeoutMs: Math.max(1000, Number($("ai-timeoutMs").value) || 30000)
      }
    };
    fetch("/skills/global-llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, data: d }; });
    }).then(function (r) {
      $("ai-msg").textContent = r.ok ? T("saved") : ("失敗：" + (r.data.error || ""));
    }).catch(function () { $("ai-msg").textContent = "失敗"; });
  });

  function manageRow(labelText, badgeText, btnText, onAction, search) {
    var row = document.createElement("div");
    row.className = "manage-row";
    row.setAttribute("data-search", search || "");
    row.title = labelText;
    var label = document.createElement("div");
    label.className = "manage-name";
    var nameEl = document.createElement("span");
    nameEl.textContent = labelText;
    label.appendChild(nameEl);
    if (badgeText) {
      var badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = badgeText;
      label.appendChild(badge);
    }
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = btnText;
    btn.addEventListener("click", onAction);
    row.append(label, btn);
    return row;
  }

  function removeSkill(id) {
    fetch("/skills/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (x) { return { ok: r.ok, data: x }; });
    }).then(function (r) {
      if (r.ok) { loadInstalled(); loadSkills(); }
      else { alert(T("remove_failed") + (r.data.error || "")); }
    });
  }

  function upgradeSkill(id) {
    fetch("/skills/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (x) { return { ok: r.ok, data: x }; });
    }).then(function (r) {
      if (r.ok) { loadInstalled(); loadSkills(); }
      else { alert(T("upgrade_failed") + (r.data.error || "")); }
    });
  }

  function rollbackSkill(id) {
    if (!window.confirm(T("confirm_rollback").replace("{id}", id))) return;
    fetch("/skills/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (x) { return { ok: r.ok, data: x }; });
    }).then(function (r) {
      if (r.ok) { loadInstalled(); loadSkills(); }
      else { alert(T("rollback_failed") + (r.data.error || "")); }
    });
  }

  function loadInstalled() {
    var pInstalled = fetch("/skills/installed.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; });
    var pUpdates = fetch("/skills/updates.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; });
    Promise.all([pInstalled, pUpdates])
      .then(function (arr) {
        var d = arr[0];
        if (!d) return;
        var updatesById = {};
        ((arr[1] && arr[1].updates) || []).forEach(function (u) { updatesById[u.id] = u; });
        var items = [];
        (d.installed || []).forEach(function (s) {
          var def = skillDef(s.id) || {};
          var hay = searchHay([s.name, s.id, def.name, def.category, def.description]);
          var upd = updatesById[s.id];
          var label = s.name + (s.version ? " v" + s.version : "") + "（" + s.id + "）";
          if (upd && upd.canUpgrade) label += " → v" + upd.latestVersion;
          var row = manageRow(
            label,
            upd && upd.canUpgrade ? T("badge_update") : T("lbl_external"),
            T("btn_uninstall"),
            function () {
              if (!window.confirm(T("confirm_remove_external").replace("{id}", s.id))) return;
              removeSkill(s.id);
            },
            hay
          );
          // P3：可更新就地升級、有備份就地回滾（都走同一列，不用跳頁）。
          if (upd && upd.canUpgrade && upd.apiOk) {
            var upBtn = document.createElement("button");
            upBtn.type = "button";
            upBtn.textContent = T("btn_upgrade");
            upBtn.addEventListener("click", function () { upgradeSkill(s.id); });
            row.appendChild(upBtn);
          }
          if (s.hasBackup) {
            var rbBtn = document.createElement("button");
            rbBtn.type = "button";
            rbBtn.textContent = T("btn_rollback");
            rbBtn.addEventListener("click", function () { rollbackSkill(s.id); });
            row.appendChild(rbBtn);
          }
          items.push({
            categoryZh: def.categoryZh || "",
            category: def.category || "",
            el: row
          });
        });
        (d.builtin || []).forEach(function (s) {
          var def = skillDef(s.id) || {};
          var hay = searchHay([s.name, s.id, def.name, def.category, def.description]);
          items.push({
            categoryZh: def.categoryZh || "",
            category: def.category || "",
            el: manageRow(
              s.name + "（" + s.id + "）",
              T("lbl_builtin"),
              T("btn_uninstall"),
              function () {
                if (!window.confirm(T("confirm_hide_builtin").replace("{id}", s.id))) return;
                removeSkill(s.id);
              },
              hay
            )
          });
        });
        var host = $("installed-list");
        if (!renderGroups(host, items, { boxed: true })) {
          var empty = document.createElement("div");
          empty.className = "msg";
          var t = document.createElement("span");
          t.textContent = T("no_installed") + " ";
          var lib = document.createElement("a");
          lib.href = "/library/";
          lib.target = "_blank";
          lib.rel = "noopener";
          lib.textContent = T("lbl_skill_library");
          empty.append(t, lib);
          host.replaceChildren(empty);
        }
        var hrows = [];
        (d.hidden || []).forEach(function (id) {
          hrows.push(manageRow(id, "", T("btn_restore"), function () {
            fetch("/skills/restore", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: id })
            }).then(function (r) {
              return r.json().catch(function () { return {}; }).then(function (x) { return { ok: r.ok, data: x }; });
            }).then(function (r) {
              if (r.ok) { loadInstalled(); loadSkills(); }
              else { alert(T("restore_failed") + (r.data.error || "")); }
            });
          }, searchHay([id])));
        });
        var hhost = $("hidden-list");
        if (hrows.length === 0) {
          var hempty = document.createElement("div");
          hempty.className = "msg";
          hempty.textContent = T("no_hidden");
          hhost.replaceChildren(hempty);
        } else {
          hhost.replaceChildren.apply(hhost, hrows);
        }
        applyManageFilter();
      })
      .catch(function () {});
  }

  $("skill-install-btn").addEventListener("click", function () {
    var input = $("skill-zip");
    if (!input.files || !input.files[0]) { $("install-msg").textContent = "請先選擇 zip"; return; }
    var file = input.files[0];
    $("install-msg").textContent = "上傳安裝中…";
    file.arrayBuffer().then(function (buf) {
      return fetch("/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buf
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (x) { return { ok: r.ok, data: x }; });
    }).then(function (r) {
      if (!r.ok) { $("install-msg").textContent = "安裝失敗：" + (r.data.error || ""); return; }
      $("install-msg").textContent = "已安裝：" + r.data.id + "（" + r.data.files + " 檔）";
      input.value = "";
      loadInstalled();
      loadSkills();
    }).catch(function () { $("install-msg").textContent = "安裝失敗"; });
  });

  function skillDef(id) {
    for (var i = 0; i < SKILL_DEFS.length; i++) if (SKILL_DEFS[i].id === id) return SKILL_DEFS[i];
    return null;
  }

  function fieldWrap(labelText, input) {
    var wrap = document.createElement("div");
    wrap.className = "field";
    var label = document.createElement("label");
    label.textContent = labelText;
    wrap.append(label, input);
    return wrap;
  }

  function buildFieldInput(f) {
    var input;
    if (f.type === "textarea") {
      input = document.createElement("textarea");
      input.style.minHeight = "110px";
    } else if (f.type === "select") {
      input = document.createElement("select");
      (f.options || []).forEach(function (opt) {
        var o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        input.appendChild(o);
      });
    } else {
      input = document.createElement("input");
      input.type = f.secret ? "password" : "text";
    }
    input.className = "sf";
    input.setAttribute("data-key", f.key);
    input.style.width = "100%";
    if (f.hint) input.placeholder = f.hint;
    return input;
  }

  function buildFileField(f) {
    var wrap = document.createElement("div");
    var input = document.createElement("input");
    input.type = "text";
    input.className = "sf";
    input.setAttribute("data-key", f.key);
    input.style.flex = "1";
    if (f.hint) input.placeholder = f.hint;
    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.style.display = "none";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = T("btn_upload");
    var status = document.createElement("span");
    status.className = "msg";
    btn.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
      if (!fileInput.files || !fileInput.files[0]) return;
      var file = fileInput.files[0];
      status.textContent = "上傳中…";
      file.arrayBuffer().then(function (buf) {
        return fetch("/settings/upload", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
          body: buf
        });
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, data: data }; });
      }).then(function (r) {
        if (!r.ok) { status.textContent = "失敗：" + (r.data.error || ""); return; }
        input.value = r.data.path;
        status.textContent = "已上傳（" + r.data.bytes + " bytes）";
      }).catch(function () { status.textContent = "上傳失敗"; });
      fileInput.value = "";
    });
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;align-items:center";
    row.append(input, btn, fileInput, status);
    wrap.append(row);
    return wrap;
  }

  function buildRuleRow(def, rule) {
    rule = rule || {};
    var row = document.createElement("div");
    row.className = "rule-row";
    row.style.cssText = "border:1px solid rgba(34,211,238,.2);border-radius:10px;padding:10px 12px;margin-bottom:8px;background:rgba(0,0,0,.18)";
    (def.ruleFields || []).forEach(function (f) {
      var input = buildFieldInput(f);
      input.className = "rf";
      input.value = rule[f.key] != null ? String(rule[f.key]) : (f.type === "select" && f.options ? f.options[0].value : "");
      if (f.type === "select") input.value = rule[f.key] || (f.options ? f.options[0].value : "");
      row.appendChild(fieldWrap(f.label, input));
    });
    var actions = document.createElement("div");
    actions.className = "actions";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = T("btn_delete_rule");
    remove.addEventListener("click", function () { row.remove(); });
    actions.appendChild(remove);
    row.appendChild(actions);
    return row;
  }

  var openCards = [];

  function setCardOpen(entry, value) {
    entry.open = value;
    entry.body.hidden = !value;
    entry.toggleBtn.textContent = value ? "\u25be" : "\u25b8";
    entry.card.classList.toggle("open", value);
  }

  function openCard(entry) {
    openCards.forEach(function (other) { if (other !== entry) setCardOpen(other, false); });
    setCardOpen(entry, true);
  }

  function buildSkillCard(skill) {
    skill = skill || {};
    var def = skillDef(skill.id);
    if (!def) return null;
    var enabledFlag = skill.enabled === true;

    var card = document.createElement("div");
    card.className = "glass skill-card";
    card.setAttribute("data-skill-id", def.id);

    var head = document.createElement("div");
    head.className = "skill-head";
    var title = document.createElement("div");
    var h = document.createElement("div");
    h.style.cssText = "font-weight:700;color:#a5f3fc;font-size:16px";
    h.textContent = def.name;
    title.appendChild(h);
    var desc = document.createElement("div");
    desc.className = "msg skill-desc";
    desc.textContent = def.description || "";
    title.appendChild(desc);
    var healthBox = document.createElement("div");
    healthBox.className = "skill-health";
    healthBox.style.cssText = "margin-top:4px;font-size:12px";
    healthBox.setAttribute("data-skill-id", def.id);
    title.appendChild(healthBox);
    var usageBox = document.createElement("div");
    usageBox.className = "skill-usage";
    usageBox.style.cssText = "margin-top:4px;font-size:12px;color:#9db4c8";
    usageBox.setAttribute("data-skill-id", def.id);
    title.appendChild(usageBox);
    var conflicts = (window.SKILL_CONFLICTS || {})[def.id] || [];
    if (conflicts.length > 0) {
      var warnBox = document.createElement("div");
      warnBox.className = "msg";
      warnBox.style.cssText = "margin-top:6px;font-size:12px;color:#f0a35e";
      warnBox.textContent = T("trigger_conflict") + "：" + conflicts.map(function (c) {
        var names = c.others.map(function (id) {
          var d = skillDef(id);
          return d ? d.name : id;
        });
        return "「" + c.word + "」↔ " + names.join("、");
      }).join("；") + "。" + T("trigger_conflict_hint");
      title.appendChild(warnBox);
    }
    var enableWrap = document.createElement("label");
    enableWrap.style.cssText = "display:flex;align-items:center;gap:8px;white-space:nowrap";
    var enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "sk-enabled";
    enabled.checked = enabledFlag;
    enableWrap.append(enabled, document.createTextNode(T("lbl_enabled")));

    var toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "sk-toggle";
    toggleBtn.title = T("lbl_expand");

    var right = document.createElement("div");
    right.style.cssText = "display:flex;align-items:center;gap:8px;white-space:nowrap";
    right.append(enableWrap, toggleBtn);

    head.append(title, right);
    card.appendChild(head);

    var body = document.createElement("div");
    body.className = "skill-body";

    if (def.triggerMode === "any") {
      var anyNote = document.createElement("div");
      anyNote.className = "msg";
      anyNote.style.cssText = "margin:4px 0 10px";
      anyNote.textContent = T("skill_trigger_any");
      body.appendChild(anyNote);
    } else if (!def.hideTrigger) {
      var trigger = document.createElement("input");
      trigger.type = "text";
      trigger.className = "sk-trigger";
      trigger.value = skill.trigger || def.defaultTrigger || "";
      trigger.placeholder = def.defaultTrigger || T("lbl_trigger");
      body.appendChild(fieldWrap(T("lbl_trigger"), trigger));
    }

    var allowUsers = document.createElement("textarea");
    allowUsers.className = "sk-allow-users";
    allowUsers.style.minHeight = "44px";
    allowUsers.value = ((skill.allowedUsers || []).join("\\n"));
    var allowWrap = fieldWrap(T("lbl_allow_users"), allowUsers);
    var allowHint = document.createElement("div");
    allowHint.className = "msg";
    allowHint.textContent = T("hint_allow_users");
    allowWrap.appendChild(allowHint);
    body.appendChild(allowWrap);

    (def.fields || []).forEach(function (f) {
      if (f.type === "file") {
        body.appendChild(fieldWrap(f.label, buildFileField(f)));
        return;
      }
      var input = buildFieldInput(f);
      input.value = (skill.config && skill.config[f.key]) || (f.type === "select" && f.options ? f.options[0].value : "");

      if (f.key === "model") {
        var listId = "models-" + def.id;
        var dl = document.createElement("datalist");
        dl.id = listId;
        input.setAttribute("list", listId);
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = T("btn_list_models");
        var msg = document.createElement("span");
        msg.className = "msg";
        btn.addEventListener("click", function () {
          msg.textContent = "…";
          var cfg = {};
          Array.prototype.forEach.call(card.querySelectorAll(".sf"), function (el) {
            cfg[el.getAttribute("data-key")] = el.value.trim();
          });
          fetch("/skills/llm/models", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(cfg)
          }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; });
          }).then(function (r) {
            if (!r.ok) { msg.textContent = "失敗：" + (r.data.error || ""); return; }
            dl.replaceChildren.apply(dl, (r.data.models || []).map(function (m) {
              var o = document.createElement("option");
              o.value = m;
              return o;
            }));
            msg.textContent = "共 " + (r.data.models || []).length + " 個";
            if (!input.value && r.data.models && r.data.models.length) input.value = r.data.models[0];
          }).catch(function () { msg.textContent = "讀取失敗"; });
        });
        var row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px;align-items:center";
        row.append(input, btn, msg);
        body.appendChild(fieldWrap(f.label, row));
        body.appendChild(dl);
        return;
      }

      body.appendChild(fieldWrap(f.label, input));
    });

    if (def.ruleFields && def.ruleFields.length > 0) {
      var host = document.createElement("div");
      host.className = "rule-list";
      var parsed = [];
      try { parsed = JSON.parse((skill.config && skill.config[def.ruleKey]) || "[]") || []; } catch (e) { parsed = []; }
      if (parsed.length === 0) parsed = [{}];
      parsed.forEach(function (r) { host.appendChild(buildRuleRow(def, r)); });
      var ruleActions = document.createElement("div");
      ruleActions.className = "actions";
      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.textContent = T("btn_add_rule");
      addBtn.addEventListener("click", function () { host.appendChild(buildRuleRow(def, {})); });
      ruleActions.appendChild(addBtn);
      body.appendChild(host);
      body.appendChild(ruleActions);
    }

    // P2 試跑：沙盒執行，只看輸出不實際發送。
    var dryWrap = document.createElement("div");
    dryWrap.style.cssText = "margin-top:10px;border-top:1px solid rgba(255,255,255,.08);padding-top:8px";
    var dryRow = document.createElement("div");
    dryRow.style.cssText = "display:flex;gap:8px;align-items:center";
    var dryInput = document.createElement("input");
    dryInput.type = "text";
    dryInput.placeholder = T("ph_dry_run");
    dryInput.style.cssText = "flex:1";
    var dryBtn = document.createElement("button");
    dryBtn.type = "button";
    dryBtn.textContent = T("btn_dry_run");
    dryRow.append(dryInput, dryBtn);
    dryWrap.appendChild(dryRow);
    var dryNote = document.createElement("div");
    dryNote.className = "msg";
    dryNote.style.cssText = "font-size:11px;margin-top:4px";
    dryNote.textContent = T("dryrun_preview_note");
    dryWrap.appendChild(dryNote);
    var dryOut = document.createElement("div");
    dryOut.className = "msg";
    dryOut.style.cssText = "margin-top:6px;font-size:12px;white-space:pre-wrap";
    dryWrap.appendChild(dryOut);
    dryBtn.addEventListener("click", function () {
      var q = dryInput.value.trim();
      if (!q) return;
      dryOut.textContent = "…";
      fetch("/skills/dry-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: def.id, text: q })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; });
      }).then(function (r) {
        if (!r) return;
        if (!r.ok) { dryOut.textContent = "失敗：" + ((r.data && r.data.error) || ""); return; }
        var d = r.data || {};
        var lines = [];
        ((d.replies || [])).forEach(function (t) { lines.push("回覆：" + t); });
        ((d.media || [])).forEach(function (m) { lines.push("媒體：" + m.kind + (m.filename ? " " + m.filename : "")); });
        ((d.scheduled || [])).forEach(function (s) { lines.push("排程：" + s); });
        ((d.watched || [])).forEach(function (w) { lines.push("監控：" + w); });
        if (d.ok === false) lines.push("失敗：" + (d.error || ""));
        dryOut.textContent = lines.length > 0 ? lines.join("\\n") : "（無輸出）";
      }).catch(function () { dryOut.textContent = "讀取失敗"; });
    });
    dryInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); dryBtn.click(); }
    });
    body.appendChild(dryWrap);

    card.appendChild(body);

    var entry = { card: card, body: body, toggleBtn: toggleBtn, open: false };
    openCards.push(entry);
    setCardOpen(entry, false); // 預設全部收合

    toggleBtn.addEventListener("click", function () {
      if (entry.open) setCardOpen(entry, false);
      else openCard(entry);
    });

    enabled.addEventListener("change", function () {
      // 啟用後自動展開（並收合其他卡片），取消啟用則收合
      if (enabled.checked) openCard(entry);
      else setCardOpen(entry, false);
    });

    return card;
  }

  var CATEGORY_ORDER = ["智慧助理", "交通", "金融理財", "生活資訊", "生活消費", "購物消費", "內容訂閱", "自動化", "工具"];

  function catRank(catZh) {
    var i = CATEGORY_ORDER.indexOf(catZh);
    return i === -1 ? 999 : i;
  }

  function searchHay(parts) {
    return (parts || []).join(" ").toLowerCase();
  }

  function renderGroups(host, items, opts) {
    opts = opts || {};
    if (items.length === 0) return false;
    var groups = {};
    items.forEach(function (it) {
      var key = it.categoryZh || "";
      if (!groups[key]) groups[key] = { label: it.category || T("lbl_category_other"), rank: catRank(key), els: [] };
      groups[key].els.push(it.el);
    });
    var keys = Object.keys(groups).sort(function (a, b) { return groups[a].rank - groups[b].rank; });
    var out = [];
    keys.forEach(function (key) {
      var g = groups[key];
      var wrap = document.createElement("div");
      wrap.className = "skill-group" + (opts.boxed ? " glass" : "");
      var h = document.createElement("h2");
      h.textContent = g.label + "（" + g.els.length + "）";
      wrap.appendChild(h);
      if (opts.grid) {
        var grid = document.createElement("div");
        grid.className = "skill-grid";
        g.els.forEach(function (el) { grid.appendChild(el); });
        wrap.appendChild(grid);
      } else {
        g.els.forEach(function (el) { wrap.appendChild(el); });
      }
      out.push(wrap);
    });
    host.replaceChildren.apply(host, out);
    return true;
  }

  function filterBlocks(hostId, filterId, itemSelector, extra) {
    var q = (($(filterId) && $(filterId).value) || "").trim().toLowerCase();
    var host = $(hostId);
    if (!host) return;
    Array.prototype.forEach.call(host.querySelectorAll(itemSelector), function (el) {
      var hay = el.getAttribute("data-search") || "";
      var show = !q || hay.indexOf(q) !== -1;
      if (show && extra) show = extra(el);
      el.style.display = show ? "" : "none";
    });
    Array.prototype.forEach.call(host.querySelectorAll(".skill-group"), function (g) {
      var visible = 0;
      Array.prototype.forEach.call(g.querySelectorAll(itemSelector), function (el) {
        if (el.style.display !== "none") visible += 1;
      });
      g.style.display = visible ? "" : "none";
    });
  }

  function applySkillFilter() {
    var onlyDisabled = $("skill-filter-disabled") && $("skill-filter-disabled").checked;
    filterBlocks("skillList", "skill-filter", ".skill-card", onlyDisabled ? function (card) {
      var enabled = card.querySelector(".sk-enabled");
      return !enabled || !enabled.checked;
    } : null);
  }

  function applyManageFilter() {
    filterBlocks("installed-list", "manage-filter", "[data-search]");
    filterBlocks("hidden-list", "manage-filter", "[data-search]");
  }

  // P2 使用分析：id -> usage.json 列（fill 前為空；排序時無數據視為 0 次）。
  var SKILL_USAGE = {};
  var HEALTH_DATA = null;
  var LAST_SKILLS = null;

  function usageRuns(id) {
    var r = SKILL_USAGE[id];
    return r ? r.runs7d : 0;
  }

  function fillHealthBox() {
    if (!HEALTH_DATA) return;
    var journal = HEALTH_DATA.journal || {};
    Array.prototype.forEach.call(document.querySelectorAll(".skill-health"), function (box) {
      var id = box.getAttribute("data-skill-id");
      var parts = [];
      var list = (HEALTH_DATA.health || {})[id];
      if (list && list.length > 0) {
        parts.push(list.map(function (h) {
          return (h.ok ? "✅ " : "❌ ") + h.name + (h.detail ? "（" + h.detail + "）" : "");
        }).join("　"));
      }
      var j = journal[id];
      if (j && j.lastAt) {
        var s = (j.lastOk ? "✅ " : "❌ ") + T("lbl_last_run") + " " + new Date(j.lastAt).toLocaleString();
        if (j.consecFails > 0) s += "｜" + T("lbl_consec_fails") + " " + j.consecFails + " 次" + (j.lastError ? "：" + j.lastError : "");
        parts.push(s);
      }
      if (parts.length > 0) box.textContent = parts.join("　");
    });
  }

  function fillUsageBox() {
    Array.prototype.forEach.call(document.querySelectorAll(".skill-usage"), function (box) {
      var r = SKILL_USAGE[box.getAttribute("data-skill-id")];
      if (!r) return;
      box.textContent = r.runs7d > 0
        ? T("lbl_usage_7d") + " " + r.runs7d + " 次｜" + T("lbl_usage_fail") + " " + r.failRate + "%"
        : T("lbl_usage_never");
    });
  }

  function renderSkillList(skills, sortMode) {
    openCards = [];
    var byId = {};
    (skills || []).forEach(function (s) { byId[s.id] = s; });
    var list = $("skillList");
    var items = [];
    SKILL_DEFS.forEach(function (def, idx) {
      var card = buildSkillCard(byId[def.id] || { id: def.id, enabled: false, trigger: def.defaultTrigger, config: {} });
      if (!card) return;
      card.setAttribute("data-search", searchHay([def.name, def.id, def.description, def.defaultTrigger, def.category]));
      items.push({ el: card, categoryZh: def.categoryZh, category: def.category, idx: idx, id: def.id });
    });
    if (sortMode && sortMode !== "default") {
      var desc = sortMode === "more";
      items.sort(function (a, b) {
        var d = usageRuns(desc ? b.id : a.id) - usageRuns(desc ? a.id : b.id);
        return d !== 0 ? d : a.idx - b.idx;
      });
      // 排序檢視壓平分類（找「沒人用的」時跨分類一次看完）。
      list.replaceChildren.apply(list, items.map(function (it) { return it.el; }));
    } else if (!renderGroups(list, items, { grid: true })) {
      var empty = document.createElement("div");
      empty.className = "glass msg";
      empty.textContent = T("no_skills");
      list.replaceChildren(empty);
      return;
    }
    applySkillFilter();
    fillHealthBox();
    fillUsageBox();
  }

  function collectSkills() {
    var out = [];
    var cards = $("skillList").querySelectorAll(".skill-card");
    Array.prototype.forEach.call(cards, function (card) {
      var id = card.getAttribute("data-skill-id") || "";
      var def = skillDef(id);
      if (!def) return;
      var config = {};
      Array.prototype.forEach.call(card.querySelectorAll(".sf"), function (input) {
        config[input.getAttribute("data-key")] = input.value.trim();
      });
      if (def.ruleFields && def.ruleFields.length > 0) {
        var rules = [];
        Array.prototype.forEach.call(card.querySelectorAll(".rule-row"), function (rowEl) {
          var rule = {};
          Array.prototype.forEach.call(rowEl.querySelectorAll(".rf"), function (input) {
            rule[input.getAttribute("data-key")] = input.value.trim();
          });
          if (rule.keyword && rule.keyword.length > 0) rules.push(rule);
        });
        config[def.ruleKey] = JSON.stringify(rules);
      }
      out.push({
        id: id,
        enabled: card.querySelector(".sk-enabled").checked,
        trigger: card.querySelector(".sk-trigger") ? card.querySelector(".sk-trigger").value.trim() : "",
        allowedUsers: card.querySelector(".sk-allow-users")
          ? card.querySelector(".sk-allow-users").value.split(/[\\\\r\\\\n,]+/).map(function (x) { return x.trim(); }).filter(Boolean)
          : [],
        config: config
      });
    });
    return out.filter(function (s) { return s.id; });
  }

  function currentSortMode() {
    return $("skill-sort") ? $("skill-sort").value : "default";
  }

  function loadSkills() {
    fetch("/settings.json", { cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) { window.location.href = "/login"; return null; }
        return res.ok ? res.json() : null;
      })
      .then(function (s) {
        if (!s) return;
        $("assistant-enabled").checked = !!(s.assistant && s.assistant.enabled);
        $("assistant-name").value = (s.assistant && s.assistant.name) || "阿寶";
        LAST_SKILLS = s.skills;
        renderSkillList(s.skills, currentSortMode());
        loadHealth();
        loadUsage();
      })
      .catch(function () {});
  }

  function loadHealth() {
    fetch("/skills/health", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;
        HEALTH_DATA = data;
        fillHealthBox();
      })
      .catch(function () {});
  }

  function loadUsage() {
    fetch("/skills/usage.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        SKILL_USAGE = {};
        ((data && data.skills) || []).forEach(function (r) { SKILL_USAGE[r.id] = r; });
        fillUsageBox();
        // 用量到齊後若使用者已切排序，重排一次（不再打 API）。
        if (LAST_SKILLS && currentSortMode() !== "default") renderSkillList(LAST_SKILLS, currentSortMode());
      })
      .catch(function () {});
  }

  function initSkillSort() {
    var sel = $("skill-sort");
    if (!sel) return;
    [["default", "sort_default"], ["more", "sort_more"], ["less", "sort_less"]].forEach(function (kv) {
      var o = document.createElement("option");
      o.value = kv[0];
      o.textContent = T(kv[1]);
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () {
      if (LAST_SKILLS) renderSkillList(LAST_SKILLS, sel.value);
    });
  }

  $("skills-save").addEventListener("click", function () {
    $("skills-msg").textContent = "儲存中…";
    var payload = {
      assistant: {
        enabled: $("assistant-enabled").checked,
        name: $("assistant-name").value.trim() || "阿寶"
      },
      skills: collectSkills()
    };
    fetch("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (res.status === 401) { window.location.href = "/login"; return null; }
      return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, data: d }; });
    }).then(function (r) {
      if (!r) return;
      $("skills-msg").textContent = r.ok ? T("saved") : ("失敗：" + (r.data.error || ""));
    }).catch(function () { $("skills-msg").textContent = "失敗"; });
  });

  $("skill-filter").addEventListener("input", applySkillFilter);
  $("skill-filter-disabled").addEventListener("change", applySkillFilter);
  $("manage-filter").addEventListener("input", applyManageFilter);

  initSkillSort();
  loadSkills();
  loadInstalled();
  loadAiSettings();

  // 深連結：/skills#schedules 直達排程頁籤（舊 /schedules 書籤由 server 轉址過來）。
  (function () {
    var h = "";
    try { h = (location.hash || "").replace("#", ""); } catch (e) {}
    if (h === "schedules") {
      var btn = document.querySelector('#skills-subnav .fn-card[data-tab="schedules"]');
      if (btn) btn.click();
    }
  })();
${schedulesTabScript()}`;
    return page(tr(config.language, "title_skills"), "skills", body, script, { sidebar });
}
