/* P1 統一排程中心：跨平台排程一覽＋單一靜音/改頻率/刪除＋勿擾時段＋全部靜音。 */
import { config } from "../../config.js";
import { tr } from "../../i18n.js";
import { page } from "../shell.js";

export function renderSchedulesHtml() {
  const body = `
<div class="glass" style="margin-bottom:16px">
  <h2 style="margin-top:0" data-i18n="sched_quiet_title">勿擾與靜音</h2>
  <div class="field"><label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input id="sch-quiet-on" type="checkbox" style="width:auto"><span data-i18n="sched_quiet">勿擾時段（延後執行，不丟失）</span></label></div>
  <div class="field"><span style="display:flex;gap:8px;align-items:center"><input id="sch-quiet-from" placeholder="23:00" style="width:110px"><span>–</span><input id="sch-quiet-to" placeholder="07:00" style="width:110px"><button type="button" id="sch-quiet-save" data-i18n="sched_save">儲存</button><span id="sch-quiet-msg" class="msg"></span></span><div class="hint" data-i18n="sched_quiet_hint">格式 HH:mm；起晚於訖代表跨夜。一次性訊息不受影響。</div></div>
  <div class="field"><label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input id="sch-mute-all" type="checkbox" style="width:auto"><span data-i18n="sched_mute_all">全部靜音（所有推播直接略過）</span></label></div>
</div>
<div class="glass">
  <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
    <h2 style="margin:0" data-i18n="sched_jobs">排程一覽</h2>
    <button type="button" id="sch-reload" data-i18n="sched_reload">重新整理</button>
    <span id="sch-msg" class="msg"></span>
  </div>
  <div id="sch-list"></div>
</div>
`;
  const script = `
  function schMsg(t) { document.getElementById("sch-msg").textContent = t || ""; }
  function schPost(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; });
    });
  }
  function schTime(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso || "";
      return d.toLocaleString();
    } catch (e) { return iso || ""; }
  }
  function schLast(run) {
    if (!run) return "-";
    var when = schTime(run.at);
    return run.ok ? "✓ " + when : "✗ " + when + (run.error ? "（" + run.error + "）" : "");
  }
  function schTitle(j) {
    if (j.skillTask) return (j.skillTask.skillName || j.skillTask.skillId) + " / " + j.skillTask.task;
    return j.summary || j.id.slice(0, 8);
  }
  function schLoad() {
    schMsg("");
    fetch("/schedules.json", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
      var q = d.quiet || {};
      document.getElementById("sch-quiet-on").checked = q.enabled === true;
      document.getElementById("sch-quiet-from").value = q.from || "23:00";
      document.getElementById("sch-quiet-to").value = q.to || "07:00";
      document.getElementById("sch-mute-all").checked = d.globalMute === true;
      var host = document.getElementById("sch-list");
      var jobs = (d.jobs || []).slice().sort(function (a, b) { return String(a.runAt).localeCompare(String(b.runAt)); });
      if (jobs.length === 0) {
        host.innerHTML = '<div class="msg">' + T("sched_no_jobs") + "</div>";
        return;
      }
      var html = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px;min-width:760px"><thead><tr>' +
        "<th>" + T("sched_platform") + "</th><th>" + T("sched_task") + "</th><th>" + T("sched_target") + "</th>" +
        "<th>" + T("sched_repeat") + "</th><th>" + T("sched_next") + "</th><th>" + T("sched_last") + "</th>" +
        "<th>" + T("sched_mute") + "</th><th>" + T("sched_actions") + "</th></tr></thead><tbody>";
      jobs.forEach(function (j, i) {
        var target = (j.skillTask && j.skillTask.chat) || ((j.to || []).join("、")) || "";
        var repeat = j.repeat || "-";
        html += "<tr>" +
          "<td>" + esc(j.platform) + "</td>" +
          "<td>" + esc(schTitle(j)) + (j.lastError ? '<div class="msg">⚠ ' + esc(j.lastError) + "</div>" : "") + "</td>" +
          "<td>" + esc(target) + "</td>" +
          "<td>" + esc(j.freq || repeat) + "</td>" +
          "<td>" + esc(schTime(j.runAt)) + "</td>" +
          "<td>" + esc(schLast(j.lastRun)) + "</td>" +
          '<td><input type="checkbox" data-mute="' + i + '"' + (j.muted ? " checked" : "") + (j.skillTask ? "" : " disabled") + "></td>" +
          "<td>" +
          (j.skillTask
            ? '<input data-repeat="' + i + '" placeholder="cron" style="width:110px" value="' + esc(j.repeat || "") + '"> ' +
              '<button type="button" data-apply="' + i + '">' + T("sched_change_repeat") + "</button> "
            : "") +
          '<button type="button" data-del="' + i + '">' + T("sched_cancel") + "</button>" +
          "</td></tr>";
      });
      html += "</tbody></table></div>";
      host.innerHTML = html;
      window.__SCH_JOBS = jobs;
      host.querySelectorAll("[data-mute]").forEach(function (box) {
        box.addEventListener("change", function () {
          var j = window.__SCH_JOBS[Number(box.getAttribute("data-mute"))];
          schPost("/schedules/mute", { id: j.id, muted: box.checked }).then(function (r) {
            schMsg(r.ok ? "" : ((r.data && r.data.error) || "失敗"));
            schLoad();
          });
        });
      });
      host.querySelectorAll("[data-apply]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var i = Number(btn.getAttribute("data-apply"));
          var j = window.__SCH_JOBS[i];
          var input = host.querySelector('[data-repeat="' + i + '"]');
          schPost("/settings/scheduled/update", { platform: j.platform, id: j.id, repeat: input.value }).then(function (r) {
            schMsg(r.ok ? "" : ((r.data && r.data.error) || "失敗"));
            schLoad();
          });
        });
      });
      host.querySelectorAll("[data-del]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var j = window.__SCH_JOBS[Number(btn.getAttribute("data-del"))];
          if (!confirm(T("sched_confirm_cancel"))) return;
          schPost("/settings/scheduled/cancel", { platform: j.platform, id: j.id }).then(function (r) {
            schMsg(r.ok ? "" : ((r.data && r.data.error) || "失敗"));
            schLoad();
          });
        });
      });
    }).catch(function () { schMsg("載入失敗"); });
  }
  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  document.getElementById("sch-reload").addEventListener("click", schLoad);
  document.getElementById("sch-quiet-save").addEventListener("click", function () {
    schPost("/schedules/quiet", {
      enabled: document.getElementById("sch-quiet-on").checked,
      from: document.getElementById("sch-quiet-from").value,
      to: document.getElementById("sch-quiet-to").value
    }).then(function (r) {
      document.getElementById("sch-quiet-msg").textContent = r.ok ? T("sched_saved") : ((r.data && r.data.error) || "失敗");
      schLoad();
    });
  });
  document.getElementById("sch-mute-all").addEventListener("change", function () {
    var box = this;
    schPost("/schedules/mute-all", { muted: box.checked }).then(function (r) {
      if (!r.ok) box.checked = !box.checked;
      schLoad();
    });
  });
  schLoad();
  setInterval(schLoad, 30000);
`;
  return page(tr(config.language, "nav_schedules"), "schedules", body, script, {});
}

export default renderSchedulesHtml;
