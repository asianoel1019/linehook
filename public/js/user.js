  (function () {
    var avatar = document.getElementById("user-avatar");
    var menu = document.getElementById("user-menu");
    if (avatar && menu) {
      avatar.addEventListener("click", function (e) {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
      });
      menu.addEventListener("click", function (e) { e.stopPropagation(); });
      document.addEventListener("click", function () { menu.hidden = true; });

      var logout = document.getElementById("menu-logout");
      if (logout) {
        logout.addEventListener("click", function () {
          fetch("/logout", { method: "POST" })
            .then(function () { window.location.href = "/login"; })
            .catch(function () { window.location.href = "/login"; });
        });
      }

      var modal = document.getElementById("password-modal");
      var pwMsg = document.getElementById("pw-msg");
      var open = document.getElementById("menu-password");
      if (modal && open) {
        open.addEventListener("click", function () {
          menu.hidden = true;
          pwMsg.textContent = "";
          document.getElementById("pw-current").value = "";
          document.getElementById("pw-new").value = "";
          document.getElementById("pw-confirm").value = "";
          modal.hidden = false;
          document.getElementById("pw-current").focus();
        });
        document.getElementById("pw-cancel").addEventListener("click", function () { modal.hidden = true; });
        modal.addEventListener("click", function (e) { if (e.target === modal) modal.hidden = true; });
        document.getElementById("pw-save").addEventListener("click", function () {
          var current = document.getElementById("pw-current").value;
          var next = document.getElementById("pw-new").value;
          var confirm = document.getElementById("pw-confirm").value;
          if (next !== confirm) { pwMsg.textContent = "兩次輸入的新密碼不一致"; return; }
          pwMsg.textContent = "儲存中…";
          fetch("/settings/password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ current: current, next: next })
          }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
              return { ok: res.ok, status: res.status, data: data };
            });
          }).then(function (r) {
            if (r.status === 401) { window.location.href = "/login"; return; }
            if (!r.ok) { pwMsg.textContent = "失敗：" + (r.data.error || ""); return; }
            pwMsg.textContent = "已更新密碼";
            setTimeout(function () { modal.hidden = true; }, 800);
          }).catch(function () { pwMsg.textContent = "失敗"; });
        });
      }
    }

    var countdownEl = document.getElementById("user-countdown");
    var deadline = 0;
    var haveDeadline = false;

    function setRemaining(ms) {
      deadline = Date.now() + ms;
      haveDeadline = true;
    }

    function refreshCountdown() {
      if (!countdownEl || !haveDeadline) return null;
      var remain = deadline - Date.now();
      if (remain < 0) remain = 0;
      var total = Math.ceil(remain / 1000);
      countdownEl.textContent = ("0" + Math.floor(total / 60)).slice(-2) + ":" + ("0" + (total % 60)).slice(-2);
      return remain;
    }

    function syncSession() {
      fetch("/settings/session", { cache: "no-store" })
        .then(function (res) {
          if (res.status === 401) { window.location.href = "/login"; return null; }
          return res.ok ? res.json() : null;
        })
        .then(function (data) {
          if (data && typeof data.remainingMs === "number") setRemaining(data.remainingMs);
        })
        .catch(function () {});
    }

    var lastTouch = 0;
    function touchSession() {
      var now = Date.now();
      if (now - lastTouch < 60000) return;
      lastTouch = now;
      fetch("/settings/touch", { method: "POST" })
        .then(function (res) {
          if (res.status === 401) { window.location.href = "/login"; return null; }
          if (!res.ok) { lastTouch = 0; return null; }
          return res.json();
        })
        .then(function (data) {
          if (data && typeof data.remainingMs === "number") setRemaining(data.remainingMs);
          else if (data === null) lastTouch = 0;
        })
        .catch(function () { lastTouch = 0; });
    }

    ["click", "keydown", "input"].forEach(function (ev) {
      document.addEventListener(ev, touchSession, { passive: true });
    });

    setInterval(function () {
      var remain = refreshCountdown();
      if (remain !== null && remain <= 0) syncSession();
    }, 1000);
    setInterval(syncSession, 30000);
    syncSession();

    Array.prototype.forEach.call(document.querySelectorAll(".lang-btn"), function (btn) {
      btn.addEventListener("click", function () {
        var lang = btn.getAttribute("data-lang");
        fetch("/settings/language", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lang: lang })
        }).then(function () { window.location.reload(); })
          .catch(function () { window.location.reload(); });
      });
    });

    var langToggle = document.getElementById("lang-toggle");
    var langMenu = document.getElementById("lang-menu");
    if (langToggle && langMenu) {
      langToggle.addEventListener("click", function (e) {
        e.stopPropagation();
        langMenu.hidden = !langMenu.hidden;
      });
      langMenu.addEventListener("click", function (e) { e.stopPropagation(); });
      document.addEventListener("click", function () { langMenu.hidden = true; });
    }
  })();
