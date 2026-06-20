"use strict";
window.Site = {
  escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"]/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    })[char]);
  },

  latencyColor(value) {
    const t = Math.max(0, Math.min(1, value));
    const stops = [[31, 156, 77], [216, 197, 49], [217, 83, 79]];
    const segment = t < .5 ? 0 : 1;
    const localT = t < .5 ? t / .5 : (t - .5) / .5;
    const a = stops[segment];
    const b = stops[segment + 1];
    return "rgb(" + a.map((x, i) => Math.round(x + (b[i] - x) * localT)).join(",") + ")";
  },

  initTheme() {
    const root = document.documentElement;
    let saved = "light";
    try { saved = localStorage.getItem("d1theme") || "light"; } catch (error) {}
    root.setAttribute("data-theme", saved);
    const btn = document.getElementById("themeToggle");
    if (!btn) return;
    btn.onclick = () => {
      const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("d1theme", next); } catch (error) {}
    };
  },

  setAppClass(className) {
    document.getElementById("app").className = className;
  },

  segmentedControl({ label, ariaLabel, options, current, attr, className = "" }) {
    const labelHtml = label ? '<span class="seg-label">' + this.escapeHtml(label) + '</span>' : "";
    const groupLabel = label || ariaLabel;
    const buttons = options.map(option =>
      '<button class="seg-btn' + (current === option.value ? " active" : "") + '" type="button" ' +
        attr + '="' + this.escapeHtml(option.value) + '">' + this.escapeHtml(option.label) + '</button>'
    ).join("");
    return '<div class="seg' + (className ? " " + className : "") + '">' +
      labelHtml + '<div class="seg-set" role="group"' +
        (groupLabel ? ' aria-label="' + this.escapeHtml(groupLabel) + '"' : "") + '>' + buttons + '</div>' +
    '</div>';
  },

  pageFooter(model) {
    const repoUrl = this.escapeHtml(model.repoUrl);
    return '<footer class="pagefoot">' +
      '<div class="foot-left">' +
        '<span>Made by <a href="https://github.com/maxceem" target="_blank" rel="noopener">@maxceem</a></span>' +
        '<span class="foot-note">Not affiliated with Cloudflare.</span>' +
      '</div>' +
      '<span>Open source &mdash; <a href="' + repoUrl + '" target="_blank" rel="noopener">fork it on GitHub</a>' +
      ' and rerun these analytics on your own Cloudflare account.</span>' +
    '</footer>';
  },
};
