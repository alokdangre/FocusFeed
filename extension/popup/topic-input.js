// Comma/Enter-delimited preferences. Draft text is never silently discarded.
(function (root) {
  "use strict";
  function unique(values) {
    var seen = new Set();
    return values.map(function (value) { return String(value).trim(); }).filter(function (value) {
      var key = value.toLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  function split(value) { return String(value || "").split(/[,\n\r]+/); }
  function create(options) {
    var input = options.input, list = options.list, tags = [], composing = false;
    function values() { return unique(tags.concat(split(input.value))); }
    function changed() {
      input.removeAttribute("aria-invalid");
      if (options.onChange) options.onChange(values());
    }
    function render() {
      list.replaceChildren();
      tags.forEach(function (text, index) {
        var tag = document.createElement("span"); tag.className = "topic-tag";
        if (text.length > 160) tag.dataset.invalid = "true";
        var label = document.createElement("span"); label.className = "topic-tag-label"; label.textContent = text;
        var remove = document.createElement("button"); remove.type = "button"; remove.className = "topic-remove";
        remove.textContent = "×"; remove.setAttribute("aria-label", "Remove " + text);
        remove.addEventListener("click", function () {
          tags.splice(index, 1); render(); changed();
          var next = list.querySelectorAll("button")[index];
          (next || input).focus();
        });
        tag.append(label, remove); list.appendChild(tag);
      });
      input.placeholder = tags.length ? "Add another topic…" : options.placeholder || "Add a topic…";
    }
    function commit() {
      var next = values(), didChange = input.value !== "" || JSON.stringify(next) !== JSON.stringify(tags);
      tags = next; input.value = ""; render(); if (didChange) changed();
      return tags.slice();
    }
    input.addEventListener("input", function () {
      if (!composing && /[,\n\r]/.test(input.value)) {
        var parts = split(input.value); input.value = parts.pop(); tags = unique(tags.concat(parts)); render();
      }
      changed();
    });
    input.addEventListener("compositionstart", function () { composing = true; });
    input.addEventListener("compositionend", function () {
      composing = false;
      if (/[,\n\r]/.test(input.value)) {
        var parts = split(input.value); input.value = parts.pop(); tags = unique(tags.concat(parts)); render();
      }
      changed();
    });
    input.addEventListener("keydown", function (event) {
      if (composing || event.isComposing) return;
      if (event.key === "Enter" || event.key === ",") { event.preventDefault(); commit(); }
      else if (event.key === "Backspace" && !input.value && tags.length) {
        event.preventDefault(); input.value = tags.pop(); render(); changed();
      }
    });
    input.addEventListener("paste", function (event) {
      var text = event.clipboardData && event.clipboardData.getData("text/plain");
      if (!text || !/[,\n\r]/.test(text)) return;
      event.preventDefault();
      var start = input.selectionStart == null ? input.value.length : input.selectionStart;
      var end = input.selectionEnd == null ? start : input.selectionEnd;
      input.value = input.value.slice(0, start) + text + input.value.slice(end); commit();
    });
    input.addEventListener("blur", function () { if (!composing && input.value.trim()) commit(); });
    return {
      values: values, commit: commit,
      set: function (values) { tags = unique(values || []); input.value = ""; render(); },
      add: function (value) { tags = unique(values().concat([value])); input.value = ""; render(); changed(); input.focus(); },
      markInvalid: function (texts) {
        var invalid = new Set(texts);
        Array.from(list.children).forEach(function (tag, i) { tag.toggleAttribute("data-invalid", invalid.has(tags[i]) || tags[i].length > 160); });
        input.setAttribute("aria-invalid", invalid.size ? "true" : "false");
      },
    };
  }
  root.FocusFeedTopicInput = { create: create };
})(globalThis);
