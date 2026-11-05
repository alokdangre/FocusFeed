// One set of immediate, local controls for both settings surfaces.
(function (root) {
  "use strict";
  function create(options) {
    var state = null, pending = new Set(), rows = {}, stopped = false;
    var section = document.createElement("details"); section.className = "focusfeed-display-settings";
    var summary = document.createElement("summary"); summary.textContent = "YouTube layout";
    var note = document.createElement("p"); note.className = "focusfeed-display-note";
    note.textContent = "Changes save immediately and apply in General and Focus. Pause filtering to show hidden sections.";
    section.append(summary, note);
    FocusFeedSettings.DISPLAY_OPTIONS.forEach(function (option) {
      var row = document.createElement("label"); row.className = "focusfeed-display-row";
      if (option.parent) row.dataset.child = "true";
      var copy = document.createElement("span"), title = document.createElement("strong"), help = document.createElement("small");
      title.textContent = option.label; help.textContent = option.description;
      var control = document.createElement("input"); control.type = "checkbox"; control.setAttribute("role", "switch");
      control.id = options.prefix + "-" + option.key; control.dataset.displayPreference = option.key;
      help.id = control.id + "-hint"; row.htmlFor = control.id;
      control.setAttribute("aria-describedby", help.id); control.disabled = true;
      copy.append(title, help); row.append(copy, control); section.appendChild(row);
      rows[option.key] = { control: control, help: help };
      control.addEventListener("change", async function () {
        if (!state || pending.has(option.key)) return;
        pending.add(option.key); control.disabled = true;
        try {
          var next = await options.save({ type: "setDisplayPreference", key: option.key, enabled: control.checked });
          if (!stopped) { configure(next); if (options.onSaved) options.onSaved(next); }
        } catch (error) { if (!stopped && options.onError) options.onError(error); }
        finally { pending.delete(option.key); if (!stopped) render(); }
      });
    });
    function render() {
      FocusFeedSettings.DISPLAY_OPTIONS.forEach(function (option) {
        var entry = rows[option.key], inherited = state && option.parent && state[option.parent];
        if (!pending.has(option.key)) entry.control.checked = !!(state && state[option.key]);
        entry.control.disabled = !state || pending.has(option.key) || !!inherited;
        entry.help.textContent = inherited ? "Hidden by the parent option. Your saved choice applies when it is off." : option.description;
      });
    }
    function configure(next) {
      if (!next || state && next.revision < state.revision) return;
      state = next; render();
    }
    return { element: section, configure: configure, stop: function () { stopped = true; } };
  }
  root.FocusFeedDisplaySettings = { create: create };
})(globalThis);
