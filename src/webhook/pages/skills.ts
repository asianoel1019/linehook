/* * IM Webhook頁面模板（由 server.ts 拆出，NEXT2 D1）。 */
import { config } from "../../config.js";
import { tr } from "../../i18n.js";
import { listSkills } from "../../skills/index.js";
import { resolveText } from "../../skills/types.js";
import { page } from "../shell.js";

export function renderSkillsHtml() {
    const skillDefs = listSkills().map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: resolveText(skill.description, config.language),
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
    const body = `
<div class="glass">
  <div class="field"><label data-i18n="lbl_assistant_enabled">啟用助理</label><input id="assistant-enabled" type="checkbox"><div class="hint" data-i18n="hint_assistant">開啟後，訊息以「名稱」開頭即會呼叫技能，例如「阿寶請幫忙 火車 台北 到 高雄」</div></div>
  <div class="field"><label data-i18n="lbl_assistant_name">助理名稱</label><input id="assistant-name" type="text" placeholder="阿寶"></div>
  <div class="actions"><button type="button" id="skills-save" data-i18n="save_settings">儲存</button><span id="skills-msg" class="msg"></span></div>
</div>

<h2 data-i18n="title_skills">技能</h2>
<div class="glass">
  <div class="field"><label data-i18n="lbl_install_skill">安裝技能（上傳 .zip）</label><span style="display:flex;gap:8px;align-items:center"><input id="skill-zip" type="file" accept=".zip,application/zip" style="flex:1"><button type="button" id="skill-install-btn" data-i18n="btn_install">安裝</button><span id="install-msg" class="msg"></span></span><div class="hint" data-i18n="hint_install">zip 內含技能的 index.js（可含 skill.json）。安裝後立即生效。</div></div>
  <div id="installed-list"></div>
</div>

<div id="skillList"></div>
`;
    const script = `
  var SKILL_DEFS = ${JSON.stringify(skillDefs).replace(/</g, "\\u003c")};

  function loadInstalled() {
    fetch("/skills/installed.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (d) {
        if (!d) return;
        var host = $("installed-list");
        var rows = [];
        (d.installed || []).forEach(function (s) {
          var row = document.createElement("div");
          row.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:12px;padding:6px 0;border-top:1px solid rgba(34,211,238,.12)";
          var label = document.createElement("div");
          label.textContent = s.name + (s.version ? " v" + s.version : "") + "（" + s.id + "）";
          var btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = T("btn_uninstall");
          btn.addEventListener("click", function () {
            if (!window.confirm("移除技能 " + s.id + "？")) return;
            fetch("/skills/uninstall", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: s.id })
            }).then(function (r) {
              return r.json().catch(function () { return {}; }).then(function (x) { return { ok: r.ok, data: x }; });
            }).then(function (r) {
              if (r.ok) { loadInstalled(); loadSkills(); }
              else { alert("移除失敗：" + (r.data.error || "")); }
            });
          });
          row.append(label, btn);
          rows.push(row);
        });
        if (rows.length === 0) {
          var empty = document.createElement("div");
          empty.className = "msg";
          empty.textContent = T("no_installed");
          host.replaceChildren(empty);
        } else {
          host.replaceChildren.apply(host, rows);
        }
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

  function renderSkillList(skills) {
    openCards = [];
    var byId = {};
    (skills || []).forEach(function (s) { byId[s.id] = s; });
    var list = $("skillList");
    var cards = [];
    SKILL_DEFS.forEach(function (def) {
      var card = buildSkillCard(byId[def.id] || { id: def.id, enabled: false, trigger: def.defaultTrigger, config: {} });
      if (card) cards.push(card);
    });
    if (cards.length === 0) {
      var empty = document.createElement("div");
      empty.className = "glass msg";
      empty.textContent = T("no_skills");
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren.apply(list, cards);
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
        renderSkillList(s.skills);
        loadHealth();
      })
      .catch(function () {});
  }

  function loadHealth() {
    fetch("/skills/health", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.health) return;
        Array.prototype.forEach.call(document.querySelectorAll(".skill-health"), function (box) {
          var id = box.getAttribute("data-skill-id");
          var list = data.health[id];
          if (!list || list.length === 0) return;
          var parts = list.map(function (h) {
            return (h.ok ? "\u2705 " : "\u274c ") + h.name + (h.detail ? "（" + h.detail + "）" : "");
          });
          box.textContent = parts.join("　");
        });
      })
      .catch(function () {});
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

  loadSkills();
  loadInstalled();
`;
    return page(tr(config.language, "title_skills"), "skills", body, script);
}
