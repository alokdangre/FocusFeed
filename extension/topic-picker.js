// Searchable, local-only selection of an existing preference. No inference here.
(function (root) {
  "use strict";
  function create() {
    var current = null;
    function focus(node) { if (node && node.focus) node.focus({ preventScroll: true }); }
    function close(restoreFocus) {
      var state = current;
      if (!state) return;
      current = null;
      window.removeEventListener("resize", state.position);
      if (typeof state.node.close === "function" && state.node.open) state.node.close();
      state.node.remove();
      state.options.anchor.setAttribute("aria-expanded", "false");
      var anchor = state.options.anchor;
      if (!anchor.isConnected || !anchor.getClientRects().length || anchor.closest("[hidden], [aria-hidden='true']")) anchor = state.options.returnFocus || anchor;
      if (restoreFocus !== false && anchor.isConnected && anchor.getClientRects().length && !anchor.closest("[hidden], [aria-hidden='true']")) focus(anchor);
    }
    function open(options) {
      close(false);
      var searchable = options.topics.length > 5;
      var node = document.createElement("dialog"); node.className = "focusfeed-topic-picker";
      node.dataset.focusfeedUi = "topic-picker"; node.id = "focusfeed-topic-picker";
      node.setAttribute("role", "dialog"); node.setAttribute("aria-modal", "true");
      node.setAttribute("aria-labelledby", "focusfeed-topic-picker-title");
      node.setAttribute("aria-describedby", "focusfeed-topic-picker-description");
      var header = document.createElement("div"); header.className = "focusfeed-topic-picker-header";
      var heading = document.createElement("h2"); heading.id = "focusfeed-topic-picker-title"; heading.textContent = options.title;
      var dismiss = document.createElement("button"); dismiss.type = "button"; dismiss.className = "focusfeed-topic-picker-close";
      dismiss.textContent = "×"; dismiss.setAttribute("aria-label", "Close topic picker");
      header.append(heading, dismiss);
      var detail = document.createElement("p"); detail.id = "focusfeed-topic-picker-description"; detail.textContent = options.description;
      var search = document.createElement("input"); search.type = "search"; search.placeholder = "Search your topics…";
      search.className = "focusfeed-topic-picker-search"; search.setAttribute("aria-label", "Search your topics");
      search.setAttribute("autocomplete", "off"); search.setAttribute("spellcheck", "false"); search.setAttribute("autofocus", "");
      var count = document.createElement("div"); count.className = "focusfeed-topic-picker-count";
      count.setAttribute("role", "status"); count.setAttribute("aria-live", "polite"); count.setAttribute("aria-atomic", "true");
      var list = document.createElement("div"); list.className = "focusfeed-topic-picker-list";
      list.setAttribute("role", "group"); list.setAttribute("aria-label", "Your blocked topics");
      var error = document.createElement("p"); error.className = "focusfeed-topic-picker-error";
      error.setAttribute("role", "alert"); error.hidden = true;
      node.append(header, detail);
      if (searchable) node.appendChild(search);
      count.hidden = !searchable;
      node.append(count, list, error);
      var state = { node: node, options: options, busy: false, buttons: [] }; current = state;
      function setBusy(busy) {
        state.busy = busy; search.disabled = busy;
        state.buttons.forEach(function (button) { button.disabled = busy; });
        node.setAttribute("aria-busy", String(busy));
        if (busy) { count.hidden = false; count.textContent = "Saving…"; }
      }
      async function select(topic) {
        if (current !== state || state.busy) return;
        error.hidden = true; setBusy(true);
        try {
          await options.onSelect(topic);
          if (current === state) close();
        } catch (failure) {
          if (current !== state) return;
          setBusy(false); count.textContent = "Choose a topic to try again";
          error.textContent = failure.message || "Could not save. Try again."; error.hidden = false;
        }
      }
      function filter() {
        if (state.busy) return;
        var words = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        var topics = options.topics.filter(function (topic) {
          var label = topic.text.toLocaleLowerCase(); return words.every(function (word) { return label.includes(word); });
        });
        list.replaceChildren(); state.buttons = [];
        count.textContent = topics.length + (topics.length === 1 ? " topic" : " topics");
        if (!topics.length) {
          var empty = document.createElement("p"); empty.className = "focusfeed-topic-picker-empty";
          empty.textContent = "No matching topics. Try another search."; list.appendChild(empty);
        }
        topics.forEach(function (topic) {
          var button = document.createElement("button"); button.type = "button"; button.className = "focusfeed-topic-choice";
          button.textContent = topic.text; button.title = topic.text;
          if (!searchable && !state.buttons.length) button.setAttribute("autofocus", "");
          button.addEventListener("click", function () { select(topic); });
          state.buttons.push(button); list.appendChild(button);
        });
      }
      state.position = function () {
        if (current !== state) return;
        var width = window.innerWidth || root.innerWidth || 1024, height = window.innerHeight || root.innerHeight || 768;
        var anchor = options.anchor.getBoundingClientRect();
        var box = node.getBoundingClientRect(), panelWidth = Math.min(340, width - 32), panelHeight = Math.min(box.height || 400, height - 32);
        var left = anchor.left === undefined ? (width - panelWidth) / 2 : anchor.left;
        var top = (anchor.bottom || 0) + 8;
        if (top + panelHeight > height - 16) top = (anchor.top || 0) - panelHeight - 8;
        node.style.left = Math.max(16, Math.min(left, width - panelWidth - 16)) + "px";
        node.style.top = Math.max(16, Math.min(top, height - panelHeight - 16)) + "px";
      };
      search.addEventListener("input", filter);
      dismiss.addEventListener("click", function () { close(); });
      node.addEventListener("cancel", function (event) { event.preventDefault(); event.stopPropagation(); close(); });
      node.addEventListener("click", function (event) { if (event.target === node) close(); });
      node.addEventListener("close", function () { if (current === state) close(); });
      node.addEventListener("keydown", function (event) {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); close(); return; }
        if (state.busy) return;
        var index = state.buttons.indexOf(event.target);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (index === -1) focus(event.key === "ArrowDown" ? state.buttons[0] : state.buttons[state.buttons.length - 1]);
          else if (searchable && event.key === "ArrowUp" && index === 0) focus(search);
          else focus(state.buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + state.buttons.length) % state.buttons.length]);
        } else if (event.key === "Enter" && event.target === search && state.buttons.length === 1) {
          event.preventDefault(); state.buttons[0].click();
        } else if (event.key === "Tab") {
          var controls = (searchable ? [dismiss, search] : [dismiss]).concat(state.buttons), at = controls.indexOf(event.target);
          if (event.shiftKey && at === 0) { event.preventDefault(); focus(controls[controls.length - 1]); }
          else if (!event.shiftKey && at === controls.length - 1) { event.preventDefault(); focus(dismiss); }
        }
      });
      filter(); (document.body || document.documentElement).appendChild(node);
      options.anchor.setAttribute("aria-expanded", "true");
      if (typeof node.showModal === "function") node.showModal(); else node.setAttribute("open", "");
      state.position(); window.addEventListener("resize", state.position); focus(searchable ? search : state.buttons[0] || dismiss);
    }
    return { open: open, close: close, contains: function (node) { return !!(current && current.node.contains(node)); },
      isOpen: function () { return !!current; } };
  }
  root.FocusFeedTopicPicker = { create: create };
})(globalThis);
