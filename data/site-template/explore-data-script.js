"use strict";
const MODEL = JSON.parse(document.getElementById("report-data").textContent);
const ROW_CHUNKS = Array.from(document.querySelectorAll("[data-report-rows]"));
const METRICS = window.MetricStats.METRICS.map(metric => [metric.key, metric.label]);
const DEFAULT_AGGREGATE_METRIC = window.MetricStats.DEFAULT_AGGREGATE_METRIC;
const state = {
  filters: {},
  metric: DEFAULT_AGGREGATE_METRIC,
  sort: "networkMs",
  dir: 1,
  expandedProviders: [],
};
let rawClusterize = null;
const dataLoad = {
  active: ROW_CHUNKS.length > 0,
  loaded: 0,
  total: ROW_CHUNKS.length,
  rows: [],
};
const esc = Site.escapeHtml;
const lerpColor = Site.latencyColor;

function fmtMsValue(v) { return v == null ? "—" : v.toFixed(v < 10 ? 1 : 0); }
// Global latency scale over the whole dataset for the current metric, so cell colors
// stay comparable no matter which filters are selected. The upper bound is capped at
// the Tukey fence (q3 + 1.5·IQR) so a few outliers don't flatten the range.
function networkScale() {
  const values = displayRows().map(row => row.networkMs).filter(v => v != null);
  if (!values.length) return { min: 0, max: 1, span: 1 };
  const lo = Math.min.apply(null, values);
  const hi = Math.max.apply(null, values);
  const q1 = window.MetricStats.percentile(values, 25);
  const q3 = window.MetricStats.percentile(values, 75);
  const cap = q3 + 1.5 * (q3 - q1);
  const max = Math.max(lo + 1, Math.min(hi, cap));
  return { min: lo, max: max, span: (max - lo) || 1 };
}
function netCell(v, scale) {
  if (v == null) return '<span class="raw-net-num muted">—</span>';
  const over = v > scale.max;
  const fillStyle = over
    ? 'width:100%'
    : 'width:' + Math.max(2, (v / scale.max) * 100).toFixed(1) + '%;background:' + lerpColor((v - scale.min) / scale.span);
  return '<span class="raw-net-bar"><span class="raw-net-fill' + (over ? " over" : "") + '" style="' + fillStyle + '"' +
    (over ? ' title="off scale (above ' + fmtMsValue(scale.max) + ' ms)"' : '') + '></span></span>' +
    '<span class="raw-net-num">' + fmtMsValue(v) + '</span>';
}
function labelValue(v) { return v == null || v === "" ? "(none)" : String(v); }
function dbLabel(key) {
  const db = MODEL.databases.find(d => d.key === key);
  return db ? (db.observedRegion || db.label || key) : key;
}
function noteValues(row) {
  const values = row.noteValues || row.notes || (row.note ? [row.note] : []);
  return values.length ? values : [null];
}
const FILTERS = {
  db: { label: "D1 target", values: row => [row.dbKey], text: dbLabel },
  placement: { label: "Worker target", values: row => [row.placement] },
  placementColo: { label: "Worker placement colo", values: row => row.placementColoValues || [row.placementColo] },
  workerColo: { label: "Worker colo", values: row => row.workerColoValues || [row.workerColo] },
  d1Region: { label: "D1 region", values: row => row.d1RegionValues || [row.d1Region] },
  d1Colo: { label: "D1 colo", values: row => row.d1ColoValues || [row.d1Colo] },
  note: { label: "Note", values: noteValues },
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
  return Object.values(state.filters).some(values => values.length);
}
function countCategory(rows, key) {
  return rows.reduce((acc, row) => {
    for (const [value, count] of filterCountEntries(row, key)) acc[value] = (acc[value] || 0) + count;
    return acc;
  }, {});
}
function filterCountEntries(row, key) {
  if (key === "db") return filterValues(row, key).map(value => [value, row.measuredQueryCount || 0]);
  if (key === "placement") return filterValues(row, key).map(value => [value, row.requestCount || 0]);
  if (key === "placementColo") return countEntries(row.placementColoCounts, filterValues(row, key));
  if (key === "workerColo") return countEntries(row.workerColoCounts, filterValues(row, key));
  if (key === "d1Region") return countEntries(row.d1RegionCounts, filterValues(row, key));
  if (key === "d1Colo") return countEntries(row.d1ColoCounts, filterValues(row, key));
  if (key === "note") return countEntries(row.noteCounts, filterValues(row, key));
  return filterValues(row, key).map(value => [value, 1]);
}
function countEntries(counts, fallbackValues) {
  const entries = Object.entries(counts || {}).filter(([, count]) => Number(count) > 0);
  if (entries.length) return entries.map(([value, count]) => [labelValue(value), Number(count)]);
  return fallbackValues.map(value => [value, 1]);
}
function sortedCounts(counts) {
  return Object.entries(counts || {}).sort((a, b) => {
    if (a[0] === "(none)") return -1;
    if (b[0] === "(none)") return 1;
    return b[1] - a[1] || a[0].localeCompare(b[0]);
  });
}
function pillHtml(key, value, count) {
  return '<button class="raw-pill' + (hasSelectedValue(key, value) ? " active" : "") + '" type="button" data-pill-filter="' + esc(key) + '" data-pill-value="' + esc(value) + '">' +
    '<span>' + esc(filterText(key, value)) + '</span><span class="c">' + count.toLocaleString() + '</span></button>';
}
function runStamp() {
  const r = MODEL.run || {};
  const start = new Date(r.startedAt || r.completedAt);
  if (isNaN(start)) {
    return '<div class="raw-run">' + esc(r.id || "") + '</div>';
  }
  const dateOpts = { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" };
  const timeOpts = { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false };
  const date = start.toLocaleDateString("en-US", dateOpts);
  let time = start.toLocaleTimeString("en-US", timeOpts);
  const end = new Date(r.completedAt);
  if (!isNaN(end)) time += "–" + end.toLocaleTimeString("en-US", timeOpts);
  return '<div class="raw-run">Measured ' + esc(date) + ' · ' + esc(time) + ' UTC</div>';
}
function render() {
  if (rawClusterize && typeof rawClusterize.destroy === "function") {
    rawClusterize.destroy(true);
    rawClusterize = null;
  }
  const app = document.getElementById("app");
  app.innerHTML =
    '<section class="raw-head">' +
      '<h1>Explore Data</h1>' +
      runStamp() +
    '</section>' +
    filtersPanel() +
    rawTable() +
    Site.pageFooter(MODEL);
  wire();
  if (dataReady()) renderRawRows();
  else updateLoadingProgress();
}

const FILTER_ORDER = ["db", "d1Region", "d1Colo", "placement", "placementColo", "workerColo", "note"];
const PROVIDER_FACETS = { placement: true };
const PROV_LABEL = { aws: "AWS", gcp: "GCP", azure: "Azure" };
const PROV_ORDER = ["aws", "gcp", "azure"];
const CHEV = '<svg class="chev" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function filtersPanel() {
  return '<section class="raw-filters">' +
    modeBar() +
    '<div class="raw-frows">' + FILTER_ORDER.map(filterRow).join("") + '</div>' +
    statRibbon() +
  '</section>';
}

function modeBar() {
  const seg = (label, attr, options, current) => Site.segmentedControl({
    label,
    options: options.map(([value, label]) => ({ value, label })),
    current,
    attr,
  });
  return '<div class="raw-bar"><div class="raw-bar-modes">' +
    seg("Metric", "data-raw-metric", METRICS, state.metric) +
    '</div>' +
    (anySelected() ? '<button class="raw-clear" type="button" data-clear-filters>Clear filters</button>' : "") +
  '</div>';
}

function filterRow(key) {
  const counts = filterCounts(key);
  const label = '<span class="raw-flab">' + esc(FILTERS[key].label) + '</span>';
  const body = PROVIDER_FACETS[key]
    ? providerPills(key, counts)
    : (sortedCounts(counts).map(([v, c]) => pillHtml(key, v, c)).join("") || '<span class="muted">—</span>');
  return '<div class="raw-frow">' + label + '<div class="raw-fpills">' + body + '</div></div>';
}

function providerPills(key, counts) {
  const groups = {};
  for (const [value, count] of sortedCounts(counts)) (groups[value.split(":")[0]] ||= []).push([value, count]);
  const provs = PROV_ORDER.filter(p => groups[p]).concat(Object.keys(groups).filter(p => !PROV_ORDER.includes(p)).sort());
  if (!provs.length) return '<span class="muted">—</span>';
  const pills = provs.map(p => {
    const open = state.expandedProviders.includes(p);
    const total = groups[p].reduce((sum, [, c]) => sum + c, 0);
    return '<button class="raw-pill raw-prov' + (open ? " open" : "") + '" type="button" data-prov-toggle="' + esc(p) + '" aria-expanded="' + open + '">' +
      CHEV + '<span>' + esc(PROV_LABEL[p] || p) + '</span><span class="c">' + total.toLocaleString() + '</span></button>';
  }).join("");
  const subs = provs.map(p =>
    '<div class="raw-sub" data-prov="' + esc(p) + '"' + (state.expandedProviders.includes(p) ? "" : " hidden") + '>' +
      groups[p].map(([v, c]) => pillHtml(key, v, c)).join("") +
    '</div>'
  ).join("");
  return pills + subs;
}

function statRibbon() {
  if (!dataReady()) {
    const total = (MODEL.rowCounts && MODEL.rowCounts.rows) || 0;
    const progress = loadPercent();
    const fig = (label, value, head) => '<div class="raw-fig' + (head ? " head" : "") + '"><div class="v">' + value + '</div><div class="k">' + esc(label) + '</div></div>';
    return '<div class="raw-ribbon">' +
      fig("Rows", esc(total.toLocaleString())) +
      fig("Status", "Loading", true) +
      fig("Data", progress == null ? "—" : esc(progress + "%")) +
    '</div>';
  }
  const rows = filteredRows();
  const totalRows = displayRows();
  const stats = window.MetricStats.metricStats(rows.map(r => r.networkMs));
  const ok = rows.filter(r => r.status === "ok").length;
  const failed = rows.filter(r => r.status === "failed").length;
  const fig = (label, value, head) => '<div class="raw-fig' + (head ? " head" : "") + '"><div class="v">' + value + '</div><div class="k">' + esc(label) + '</div></div>';
  return '<div class="raw-ribbon">' +
    fig("Visible", esc(rows.length.toLocaleString() + " / " + totalRows.length.toLocaleString())) +
    fig("Successful", esc(ok.toLocaleString())) +
    fig("Failed", esc(failed.toLocaleString())) +
    '<div class="raw-spacer"></div>' +
    METRICS.map(([key, label], i) => fig(label, fmtUnit(stats[key]), i === 0)).join("") +
  '</div>';
}

function fmtUnit(v) {
  return v == null ? "—" : v.toFixed(v < 10 ? 1 : 0) + '<span class="u">ms</span>';
}

function rawTable() {
  const cols = [
    ["db", "D1 target"],
    ["placement", "Worker target"],
    ["request", "Requests"],
    ["networkMs", "Network (ms)"],
    ["d1Region", "D1 region"],
    ["d1Colo", "D1 colo"],
    ["placementColo", "Worker plmt colo"],
    ["workerColo", "Worker colo"],
    ["note", "Note"],
  ];
  const head = cols.map(([key, label]) =>
    '<th class="' + (key === "placement" ? "l" : "") + '" data-raw-sort="' + key + '">' +
      label + (state.sort === key ? (state.dir === 1 ? " ▲" : " ▼") : "") + '</th>'
  ).join("");
  return '<section class="raw-table-panel">' +
    '<div id="rawScroll" class="raw-scroll clusterize-scroll"><table class="raw-table"><thead><tr>' + head + '</tr></thead><tbody id="rawRows" class="clusterize-content">' +
      '<tr class="clusterize-no-data raw-loading-row"><td colspan="' + cols.length + '"></td></tr>' +
    '</tbody></table>' + loadingOverlay() + '</div>' +
  '</section>';
}

function loadingOverlay() {
  if (dataReady()) return "";
  return '<div class="raw-loading" aria-live="polite">' +
    '<div class="raw-load-text">' +
      '<div class="raw-load-head"><div class="raw-load-title">Loading rows</div><div class="raw-load-percent">0%</div></div>' +
      '<div class="raw-load-status">Preparing rows.</div>' +
      '<div class="raw-load-track"><div class="raw-load-bar" style="width:0%"></div></div>' +
    '</div>' +
  '</div>';
}

function renderRawRows() {
  const rows = sortedRows(filteredRows());
  const columns = 9;
  const scale = networkScale();
  const rowMarkup = rows.map(row => rawRowHtml(row, scale));
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

function rawRowHtml(row, scale) {
  return '<tr class="raw-' + row.status + '">' +
    '<td>' + esc(row.dbLabel) + '</td>' +
    '<td class="l">' + esc(row.placement) + '</td>' +
    '<td>' + esc(requestLabel(row)) + '</td>' +
    '<td class="raw-net">' + netCell(row.networkMs, scale) + '</td>' +
    '<td>' + esc(row.d1Region || "-") + '</td>' +
    '<td>' + esc(row.d1Colo || "-") + '</td>' +
    '<td>' + esc(row.placementColo || "-") + '</td>' +
    '<td>' + esc(row.workerColo || "-") + '</td>' +
    '<td class="l raw-note">' + esc(row.note || "-") + '</td>' +
  '</tr>';
}

function filteredRows(skipKey) {
  if (!dataReady()) return [];
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
  if (!dataReady()) return [];
  return MODEL.rows.map(row => ({ ...row, networkMs: metricNetworkMs(row) }));
}

function metricNetworkMs(row) {
  return row.networkStats && row.networkStats[state.metric] != null ? row.networkStats[state.metric] : row.networkMs;
}

function sortedRows(rows) {
  const dir = state.dir;
  const key = state.sort;
  return rows.slice().sort((a, b) => {
    let av, bv;
    if (key === "db") { av = a.dbLabel; bv = b.dbLabel; }
    else if (key === "request") { av = requestSortValue(a); bv = requestSortValue(b); }
    else { av = a[key]; bv = b[key]; }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv))) * dir;
  });
}

function requestSortValue(row) {
  return row.requestCount || 0;
}
function requestLabel(row) {
  return (row.successCount || 0) + "/" + (row.requestCount || 0);
}
function unique(values) {
  return [...new Set(values.filter(v => v != null && v !== ""))].sort((a, b) => String(a).localeCompare(String(b)));
}
function dataReady() {
  return !dataLoad.active;
}
function loadPercent() {
  if (!dataLoad.total) return null;
  return Math.round((dataLoad.loaded / dataLoad.total) * 100);
}
function filterCounts(key) {
  if (dataReady()) return countCategory(filteredRows(key), key);
  return (MODEL.filterFacets && MODEL.filterFacets[key]) || {};
}
function updateLoadingProgress() {
  const percent = loadPercent();
  const status = document.querySelector(".raw-load-status");
  const bar = document.querySelector(".raw-load-bar");
  const percentText = document.querySelector(".raw-load-percent");
  const value = percent == null ? 0 : percent;
  if (status) {
    status.textContent = percent == null
      ? "Preparing rows."
      : "Loaded " + dataLoad.loaded.toLocaleString() + " of " + dataLoad.total.toLocaleString() + " chunks.";
  }
  if (bar) bar.style.width = value + "%";
  if (percentText) percentText.textContent = value + "%";
}
function startDataLoad() {
  if (!dataLoad.active) return;
  const loadChunk = () => {
    const node = ROW_CHUNKS[dataLoad.loaded];
    if (!node) {
      MODEL.rows = dataLoad.rows;
      dataLoad.active = false;
      render();
      return;
    }
    dataLoad.rows.push(...JSON.parse(node.textContent));
    dataLoad.loaded += 1;
    updateLoadingProgress();
    setTimeout(loadChunk, 0);
  };
  requestAnimationFrame(() => setTimeout(loadChunk, 0));
}
function wire() {
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
  document.querySelectorAll("[data-prov-toggle]").forEach(button => {
    button.onclick = () => {
      const prov = button.getAttribute("data-prov-toggle");
      const i = state.expandedProviders.indexOf(prov);
      if (i >= 0) state.expandedProviders.splice(i, 1);
      else state.expandedProviders.push(prov);
      render();
    };
  });
  document.querySelectorAll("[data-clear-filters]").forEach(button => {
    button.onclick = () => {
      state.filters = {};
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

Site.initTheme();
Site.setAppClass("wrap raw-wrap");
render();
startDataLoad();
