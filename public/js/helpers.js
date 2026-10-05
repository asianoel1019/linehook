  var $ = function (id) { return document.getElementById(id); };
  function td(text, className) {
    var el = document.createElement("td");
    el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function tr() {
    var row = document.createElement("tr");
    for (var i = 0; i < arguments.length; i++) row.appendChild(arguments[i]);
    return row;
  }
  function emptyRow(cols) {
    var cell = document.createElement("td");
    cell.colSpan = cols;
    cell.textContent = (typeof T === "function") ? T("no_data") : "尚無資料";
    return tr(cell);
  }
  function post(path, body) {
    var url = path.charAt(0) === "/" ? path : "/" + path;
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      if (res.status === 401) { window.location.href = "/login"; }
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, data: data };
      });
    });
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }
