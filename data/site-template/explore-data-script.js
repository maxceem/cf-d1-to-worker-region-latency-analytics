"use strict";
const MODEL = JSON.parse(document.getElementById("report-data").textContent);
const METRICS = window.MetricStats.METRICS.map(metric => [metric.key, metric.label]);
const state = {
  filters: {},
  rowMode: "request",
  queryPosition: "all",
  metric: "p95",
  sort: "index",
  dir: 1,
};
let rawClusterize = null;

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function fmt(v) { return v == null ? "—" : v.toFixed(v < 10 ? 1 : 0) + "ms"; }
function fmtNum(v) { return v == null ? "—" : v.toFixed(v < 10 ? 1 : 0); }
function fmtMsValue(v) { return v == null ? "—" : v.toFixed(v < 10 ? 1 : 0); }
function labelValue(v) { return v == null || v === "" ? "(none)" : String(v); }
function dbLabel(key) {
  const db = MODEL.databases.find(d => d.key === key);
  return db ? (db.observedRegion || db.label || key) : key;
}
const FILTERS = {
  db: { label: "D1 location", values: row => [row.dbKey], text: dbLabel },
  placement: { label: "Worker target", values: row => [row.placement] },
  placementColo: { label: "Placement colo", values: row => [labelValue(row.placementColo)] },
  workerColo: { label: "Worker colo", values: row => [labelValue(row.workerColo)] },
  d1Region: { label: "D1 region", values: row => row.d1RegionValues || [row.d1Region] },
  d1Colo: { label: "D1 colo", values: row => row.d1ColoValues || [row.d1Colo] },
  note: { label: "Note", values: row => row.noteValues || row.notes || (row.note ? [row.note] : []) },
};
function filterValues(row, key) {
  const filter = FILTERS[key];
  if (!filter) return [];
  return unique(filter.values(row).map(labelValue));
}
function filterText(key, value) {
  const filter = FILTERS[key];
  return filter && filter.text ? filter.text(value) : value;
}
function selectedValues(key) {
  return state.filters[key] || [];
}
function hasSelectedValue(key, value) {
  return selectedValues(key).includes(value);
}
function anySelected() {
  return state.queryPosition !== "all" || Object.values(state.filters).some(values => values.length);
}
function countCategory(rows, key) {
  return rows.reduce((acc, row) => {
    for (const value of filterValues(row, key)) acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}
function countsText(key, counts) {
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return "—";
  return entries.map(([k, v]) =>
    '<button class="raw-chip' + (hasSelectedValue(key, k) ? " active" : "") + '" type="button" data-pill-filter="' + esc(key) + '" data-pill-value="' + esc(k) + '">' +
      '<b>' + esc(filterText(key, k)) + '</b>' + v +
    '</button>'
  ).join("");
}
function render() {
  if (rawClusterize && typeof rawClusterize.destroy === "function") {
    rawClusterize.destroy(true);
    rawClusterize = null;
  }
  const app = document.getElementById("app");
  app.innerHTML =
    '<section class="raw-head">' +
      '<div>' +
        '<h1>Raw Request Explorer</h1>' +
        '<p class="sub">Inspect every measured query, including D1 serving location, Worker reported colo, and the placement header returned by Cloudflare.</p>' +
      '</div>' +
      '<div class="raw-run">' + esc(MODEL.run.id || "run") + '</div>' +
    '</section>' +
    filtersPanel() +
    rawTable();
  wire();
  renderRawRows();
}

function filtersPanel() {
  return '<section class="raw-filters">' +
    (anySelected() ? '<div class="raw-filter-actions"><button class="raw-clear" type="button" data-clear-filters>Clear filters</button></div>' : "") +
    rowModeSwitch() +
    queryPositionSwitch() +
    metricSwitch() +
    statsPanel() +
  '</section>';
}

function rowModeSwitch() {
  const options = [
    ["request", "Requests"],
    ["query", "Queries"],
    ["pair", "Worker target"],
  ];
  return '<div class="raw-mode-row">' +
    '<span>Rows</span>' +
    '<div class="raw-mode" role="group" aria-label="Rows">' +
      options.map(([value, label]) =>
        '<button class="raw-mode-button' + (state.rowMode === value ? " active" : "") + '" type="button" data-row-mode="' + value + '">' + label + '</button>'
      ).join("") +
    '</div>' +
  '</div>';
}

function queryPositionSwitch() {
  const options = [
    ["all", "All"],
    ["first", "First"],
    ["later", "Later"],
  ];
  return '<div class="raw-mode-row">' +
    '<span>Query position</span>' +
    '<div class="raw-mode" role="group" aria-label="Query position">' +
      options.map(([value, label]) =>
        '<button class="raw-mode-button' + (state.queryPosition === value ? " active" : "") + '" type="button" data-query-position="' + value + '">' + label + '</button>'
      ).join("") +
    '</div>' +
  '</div>';
}

function metricSwitch() {
  return '<div class="raw-mode-row">' +
    '<span>Metric</span>' +
    '<div class="raw-mode" role="group" aria-label="Metric">' +
      METRICS.map(([value, label]) =>
        '<button class="raw-mode-button' + (state.metric === value ? " active" : "") + '" type="button" data-raw-metric="' + value + '">' + label + '</button>'
      ).join("") +
    '</div>' +
  '</div>';
}

function statsPanel() {
  const rows = filteredRows();
  const totalRows = displayRows();
  const values = rows.map(r => r.networkMs);
  const stats = window.MetricStats.metricStats(values);
  const ok = rows.filter(r => r.status === "ok").length;
  const failed = rows.filter(r => r.status === "failed").length;
  const quantityStats =
    statCard("Visible", rows.length.toLocaleString() + " / " + totalRows.length.toLocaleString()) +
    statCard("Successful", ok.toLocaleString()) +
    statCard("Failed", failed.toLocaleString()) +
    statCard("Queries", rows.reduce((sum, row) => sum + (row.measuredQueryCount || 0), 0).toLocaleString());
  return '<div class="raw-insights">' +
    filterRow("db") +
    filterRow("placement") +
    filterRow("placementColo") +
    filterRow("workerColo") +
    filterRow("d1Region") +
    filterRow("d1Colo") +
    filterRow("note") +
    '<div class="raw-metric-row quantity">' +
      quantityStats +
    '</div>' +
    '<div class="raw-metric-row latency">' +
      METRICS.map(([key, label]) => statCard(label, fmt(stats[key]))).join("") +
    '</div>' +
  '</div>';
}

function statCard(label, value) {
  return '<div class="raw-stat"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
}

function filterRow(key) {
  const rows = filteredRows(key);
  return '<div class="raw-dist"><span>' + esc(FILTERS[key].label) + '</span><div>' + countsText(key, countCategory(rows, key)) + '</div></div>';
}

function rawTable() {
  const cols = [
    ["db", "D1 location"],
    ["placement", "Worker target"],
    ["query", state.rowMode === "pair" ? "Requests" : "Query #"],
    ["networkMs", "Network (ms)"],
    ["placementColo", "Placement colo"],
    ["workerColo", "Worker colo"],
    ["d1Region", "D1 region"],
    ["d1Colo", "D1 colo"],
    ["note", "Note"],
  ];
  if (state.rowMode !== "pair") cols.splice(2, 0, ["index", "Req #"]);
  const head = cols.map(([key, label]) =>
    '<th class="' + (key === "placement" ? "l" : "") + '" data-raw-sort="' + key + '">' +
      label + (state.sort === key ? (state.dir === 1 ? " ▲" : " ▼") : "") + '</th>'
  ).join("");
  return '<section class="raw-table-panel">' +
    '<div id="rawScroll" class="raw-scroll clusterize-scroll"><table class="raw-table"><thead><tr>' + head + '</tr></thead><tbody id="rawRows" class="clusterize-content">' +
      '<tr class="clusterize-no-data"><td colspan="' + cols.length + '" class="empty">Loading rows.</td></tr>' +
    '</tbody></table></div>' +
  '</section>';
}

function renderRawRows() {
  const rows = sortedRows(filteredRows());
  const columns = state.rowMode === "pair" ? 9 : 10;
  const rowMarkup = rows.map(rawRowHtml);
  const empty = '<tr class="clusterize-no-data"><td colspan="' + columns + '" class="empty">No rows match the filters.</td></tr>';
  if (typeof Clusterize === "function") {
    rawClusterize = new Clusterize({
      rows: rowMarkup,
      scrollId: "rawScroll",
      contentId: "rawRows",
      no_data_text: "No rows match the filters.",
      rows_in_block: 36,
      blocks_in_cluster: 4,
      tag: "tr"
    });
    if (!rowMarkup.length) {
      const body = document.getElementById("rawRows");
      if (body) body.innerHTML = empty;
    }
    return;
  }
  const body = document.getElementById("rawRows");
  if (body) body.innerHTML = rowMarkup.join("") || empty;
}

function rawRowHtml(row) {
  return '<tr class="raw-' + row.status + '">' +
    '<td>' + esc(row.dbLabel) + '</td>' +
    '<td class="l">' + esc(row.placement) + '</td>' +
    (row.pairIndex == null ? '<td>' + esc(rowIndexLabel(row)) + '</td>' : '') +
    '<td>' + esc(queryLabel(row)) + '</td>' +
    '<td>' + fmtMsValue(row.networkMs) + '</td>' +
    '<td>' + esc(row.placementColo || "—") + '</td>' +
    '<td>' + esc(row.workerColo || "—") + '</td>' +
    '<td>' + esc(row.d1Region || "—") + '</td>' +
    '<td>' + esc(row.d1Colo || "—") + '</td>' +
    '<td class="l raw-note">' + esc(row.note || "—") + '</td>' +
  '</tr>';
}

function filteredRows(skipKey) {
  return displayRows().filter(row => {
    for (const key of Object.keys(FILTERS)) {
      if (key === skipKey) continue;
      const selected = selectedValues(key);
      if (!selected.length) continue;
      const values = filterValues(row, key);
      if (!selected.some(value => values.includes(value))) return false;
    }
    return true;
  });
}

function displayRows() {
  if (state.rowMode === "pair") return pairRows();
  const queries = queryRows();
  return state.rowMode === "request" ? requestRows(queries) : queries;
}

function pairRows() {
  const grouped = new Map();
  for (const row of queryRows()) {
    const key = row.dbKey + "|" + row.placement;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped.values()].map((rowsForPair, pairIndex) => {
    const first = rowsForPair[0];
    const requests = groupByRequest(rowsForPair);
    const requestValues = requests
      .map(rowsForRequest => window.MetricStats.reduceMetric(rowsForRequest.map(row => row.networkMs), state.metric))
      .filter(v => v != null);
    const placementColoValues = unique(rowsForPair.map(row => row.placementColo).filter(Boolean));
    const workerColoValues = unique(rowsForPair.map(row => row.workerColo).filter(Boolean));
    const d1RegionValues = unique(rowsForPair.flatMap(row => row.d1RegionValues || [row.d1Region]).filter(Boolean));
    const d1ColoValues = unique(rowsForPair.flatMap(row => row.d1ColoValues || [row.d1Colo]).filter(Boolean));
    const noteValues = unique(rowsForPair.flatMap(row => row.notes || (row.note ? [row.note] : [])));
    const minSuccessfulRequests = MODEL.run.minSuccessfulRequests || MODEL.run.benchmark?.minSuccessfulRequests || 1;
    const successCount = requestValues.length;
    return {
      id: first.dbKey + "|" + first.placement,
      pairIndex,
      dbKey: first.dbKey,
      dbLabel: first.dbLabel,
      placement: first.placement,
      requestIndex: null,
      queryIndex: null,
      status: successCount >= minSuccessfulRequests ? "ok" : "failed",
      note: noteValues.join(", ") || null,
      notes: noteValues,
      networkMs: window.MetricStats.reduceMetric(requestValues, state.metric),
      measuredQueryCount: rowsForPair.filter(row => row.networkMs != null).length,
      successCount,
      requestCount: requests.length,
      placementColo: placementColoValues.join("+") || null,
      workerColo: workerColoValues.join("+") || null,
      d1Region: d1RegionValues.join("+") || null,
      d1Colo: d1ColoValues.join("+") || null,
      placementColoValues,
      workerColoValues,
      d1RegionValues,
      d1ColoValues,
      noteValues,
    };
  });
}

function groupByRequest(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row.dbKey + "|" + row.placement + "|" + row.requestIndex;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped.values()];
}

function queryRows() {
  return MODEL.rows.filter(row => state.queryPosition === "all" || row.queryPosition === state.queryPosition);
}

function requestRows(rows) {
  return groupByRequest(rows).map(rowsForRequest => {
    const first = rowsForRequest[0];
    const networkValues = rowsForRequest
      .map(row => row.networkMs)
      .filter(v => v != null);
    const queryIndexes = rowsForRequest
      .map(row => row.queryIndex)
      .filter(v => v != null)
      .sort((a, b) => a - b);
    const d1RegionValues = unique(rowsForRequest.map(row => row.d1Region).filter(Boolean));
    const d1ColoValues = unique(rowsForRequest.map(row => row.d1Colo).filter(Boolean));
    const noteValues = unique(rowsForRequest.flatMap(row => row.notes || (row.note ? [row.note] : [])));
    const status = rowsForRequest.some(row => row.status === "failed") ? "failed" : "ok";
    return {
      ...first,
      id: first.dbKey + "|" + first.placement + "|" + first.requestIndex,
      queryIndex: null,
      queryIndexes,
      queryLabel: queryRangeLabel(queryIndexes),
      status,
      networkMs: window.MetricStats.reduceMetric(networkValues, state.metric),
      d1Region: d1RegionValues.join("+") || null,
      d1Colo: d1ColoValues.join("+") || null,
      d1RegionValues,
      d1ColoValues,
      note: noteValues.join(", ") || null,
      noteValues,
      measuredQueryCount: networkValues.length,
    };
  });
}

function sortedRows(rows) {
  const dir = state.dir;
  const key = state.sort;
  return rows.slice().sort((a, b) => {
    let av, bv;
    if (key === "index") { av = rowIndex(a); bv = rowIndex(b); }
    else if (key === "db") { av = a.dbLabel; bv = b.dbLabel; }
    else if (key === "query") { av = querySortValue(a); bv = querySortValue(b); }
    else { av = a[key]; bv = b[key]; }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv))) * dir;
  });
}

function rowIndex(row) {
  if (row.pairIndex != null) return String(row.pairIndex).padStart(4, "0");
  return row.dbKey + row.placement + String(row.requestIndex).padStart(4, "0") + String(row.queryIndex ?? -1).padStart(4, "0");
}
function rowIndexLabel(row) {
  return row.pairIndex == null ? row.requestIndex + 1 : row.pairIndex + 1;
}
function querySortValue(row) {
  if (row.pairIndex != null) return row.successCount || 0;
  return row.queryIndexes && row.queryIndexes.length ? row.queryIndexes[0] : row.queryIndex == null ? -1 : row.queryIndex;
}
function queryLabel(row) {
  if (row.pairIndex != null) return (row.successCount || 0) + "/" + (row.requestCount || 0);
  if (row.queryLabel) return row.queryLabel;
  if (row.queryIndex == null) return "—";
  return String(row.queryIndex + 1);
}
function queryRangeLabel(indexes) {
  if (!indexes.length) return "—";
  const values = indexes.map(index => index + 1);
  const ranges = [];
  let start = values[0];
  let prev = values[0];
  for (let i = 1; i < values.length; i += 1) {
    const value = values[i];
    if (value === prev + 1) {
      prev = value;
      continue;
    }
    ranges.push(start === prev ? String(start) : start + "-" + prev);
    start = value;
    prev = value;
  }
  ranges.push(start === prev ? String(start) : start + "-" + prev);
  return ranges.join(", ");
}
function unique(values) {
  return [...new Set(values.filter(v => v != null && v !== ""))].sort((a, b) => String(a).localeCompare(String(b)));
}
function wire() {
  document.querySelectorAll("[data-row-mode]").forEach(button => {
    button.onclick = () => {
      state.rowMode = button.getAttribute("data-row-mode");
      render();
    };
  });
  document.querySelectorAll("[data-query-position]").forEach(button => {
    button.onclick = () => {
      state.queryPosition = button.getAttribute("data-query-position");
      render();
    };
  });
  document.querySelectorAll("[data-raw-metric]").forEach(button => {
    button.onclick = () => {
      state.metric = button.getAttribute("data-raw-metric");
      render();
    };
  });
  document.querySelectorAll("[data-pill-filter]").forEach(pill => {
    pill.onclick = () => {
      const key = pill.getAttribute("data-pill-filter");
      const value = pill.getAttribute("data-pill-value");
      const selected = selectedValues(key);
      state.filters[key] = selected.includes(value)
        ? selected.filter(item => item !== value)
        : selected.concat(value);
      if (!state.filters[key].length) delete state.filters[key];
      render();
    };
  });
  document.querySelectorAll("[data-clear-filters]").forEach(button => {
    button.onclick = () => {
      state.filters = {};
      state.queryPosition = "all";
      render();
    };
  });
  document.querySelectorAll("th[data-raw-sort]").forEach(th => {
    th.onclick = () => {
      const key = th.getAttribute("data-raw-sort");
      if (state.sort === key) state.dir *= -1;
      else { state.sort = key; state.dir = 1; }
      render();
    };
  });
}

(function initTheme() {
  const root = document.documentElement;
  let saved = "light";
  try { saved = localStorage.getItem("d1theme") || "light"; } catch (e) {}
  root.setAttribute("data-theme", saved);
  const btn = document.getElementById("themeToggle");
  const paint = () => { btn.textContent = root.getAttribute("data-theme") === "light" ? "☀" : "☾"; };
  paint();
  btn.onclick = () => {
    const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("d1theme", next); } catch (e) {}
    paint();
  };
})();

document.getElementById("app").className = "wrap raw-wrap";
render();
