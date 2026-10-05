  function showSection(fn, configSections) {
    Array.prototype.forEach.call(document.querySelectorAll(".fn-card"), function (card) {
      card.classList.toggle("active", card.getAttribute("data-fn") === fn);
    });

    var form = document.getElementById("settings-form");
    Array.prototype.forEach.call(document.querySelectorAll(".fn-panel[data-fn]"), function (el) {
      el.classList.remove("active");
    });

    if (configSections && configSections.indexOf(fn) !== -1 && form) {
      form.classList.add("active");
      Array.prototype.forEach.call(form.querySelectorAll("fieldset[data-fn]"), function (fs) {
        fs.classList.toggle("active", fs.getAttribute("data-fn") === fn);
      });
      return;
    }

    if (form) form.classList.remove("active");
    var target = document.querySelector('.fn-panel[data-fn="' + fn + '"]:not(form)');
    if (target) target.classList.add("active");
  }
  function setupCards(configSections, defaultFn) {
    Array.prototype.forEach.call(document.querySelectorAll(".fn-card[data-fn]"), function (card) {
      card.addEventListener("click", function () {
        showSection(card.getAttribute("data-fn"), configSections);
      });
    });
    showSection(defaultFn, configSections);
  }
