#!/usr/bin/env node
// Build a self-contained, interactive HTML analytics report from a benchmark
// raw.json file. Lets you compare Worker placements per D1 region, see the whole
// matrix at once, or filter down to a single D1 region to pick its best Worker.
//
// Usage:
//   node ./src/build-html-report.mjs [--input results/raw.json] [--output results/report.html]
//
// Defaults: reads results/raw.json (falling back to results-test/raw.json) and
// writes report.html next to the input file.

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const inputPath = await resolveInputPath(args.input);
  const raw = JSON.parse(await readFile(inputPath, "utf8"));
  const model = buildModel(raw);

  const outputPath = resolvePath(
    args.output || join(dirname(inputPath), "report.html")
  );
  const html = renderHtml(model);
  await writeFile(outputPath, html, "utf8");

  console.log(`Wrote ${outputPath}`);
  console.log(
    `D1 regions: ${model.databases.length} | Worker placements: ${model.placements.length} | pairs: ${model.pairs.length}`
  );

  if (args.open) {
    openInBrowser(outputPath);
  }
}

function openInBrowser(filePath) {
  const platform = process.platform;
  const [command, cmdArgs] =
    platform === "darwin"
      ? ["open", [filePath]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", filePath]]
        : ["xdg-open", [filePath]];
  try {
    const child = spawn(command, cmdArgs, { stdio: "ignore", detached: true });
    child.on("error", (error) => {
      console.warn(`Could not open the report automatically: ${error.message}`);
    });
    child.unref();
  } catch (error) {
    console.warn(`Could not open the report automatically: ${error.message}`);
  }
}

function parseArgs(argv) {
  const args = { input: null, output: null, help: false, open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") args.help = true;
    else if (flag === "--input" || flag === "-i") args.input = argv[++i];
    else if (flag === "--output" || flag === "-o") args.output = argv[++i];
    else if (flag === "--no-open") args.open = false;
    else if (flag === "--open") args.open = true;
    else if (!args.input) args.input = flag;
    else throw new Error(`Unexpected argument: ${flag}`);
  }
  return args;
}

function printHelp() {
  console.log(`Build an interactive HTML analytics report from benchmark raw data.

Usage:
  node ./src/build-html-report.mjs [--input <raw.json>] [--output <report.html>]

Options:
  -i, --input   Path to raw.json (default: results/raw.json, else results-test/raw.json)
  -o, --output  Path to write the HTML file (default: report.html next to the input)
      --no-open Do not open the report in a browser after generating
  -h, --help    Show this help`);
}

async function resolveInputPath(explicit) {
  if (explicit) return resolvePath(explicit);
  for (const candidate of ["results/raw.json", "results-test/raw.json"]) {
    const full = resolvePath(candidate);
    try {
      await readFile(full);
      return full;
    } catch {
      // try next
    }
  }
  // Default to results/raw.json so the error message is sensible.
  return resolvePath("results/raw.json");
}

function resolvePath(value) {
  return isAbsolute(value) ? value : resolve(rootDir, value);
}

// ---------------------------------------------------------------------------
// Model: turn raw measurements into per-pair statistics the page can render.
// ---------------------------------------------------------------------------

function buildModel(raw) {
  const run = raw.run || {};
  const databases = (raw.databases || []).map((db) => ({
    key: db.key,
    label: db.label || db.key,
    name: db.name || null,
    targetLocation: db.targetLocation || null,
    observedRegion: db.observedRegion || null,
  }));
  const placements = raw.workerPlacements || [];

  const measured = raw.measured || {};
  const pairs = [];
  for (const db of databases) {
    const byPlacement = measured[db.key] || {};
    for (const placement of placements) {
      const requests = byPlacement[placement] || [];
      pairs.push(summarizePair(db, placement, requests));
    }
  }

  // Global ranking across every D1 x Worker pair.
  const ranked = pairs
    .filter((p) => p.successCount > 0)
    .sort((a, b) => compareNullable(a.p95, b.p95) || compareNullable(a.avg, b.avg));
  const best = ranked[0] || null;

  return {
    generatedAt: new Date().toISOString(),
    run: {
      id: run.id || null,
      startedAt: run.startedAt || null,
      completedAt: run.completedAt || null,
      accountId: run.accountId || null,
      warnings: run.warnings || [],
    },
    databases,
    placements,
    pairs,
    best: best ? { dbKey: best.dbKey, placement: best.placement } : null,
  };
}

function summarizePair(db, placement, requests) {
  const ok = requests.filter((r) => r && r.ok && r.body);
  const totals = ok.map((r) => r.body.totalMs).filter(isFiniteNumber);
  const perQuery = ok.flatMap((r) => r.body.perQueryMs || []).filter(isFiniteNumber);
  const sqlDurations = ok
    .flatMap((r) => (r.body.d1 && r.body.d1.sqlDurations) || [])
    .filter(isFiniteNumber);

  const workerColos = mergeCounts(ok.map((r) => ({ [r.body.workerColo]: 1 })));
  const d1Regions = mergeCounts(ok.map((r) => (r.body.d1 && r.body.d1.regions) || {}));
  const d1Colos = mergeCounts(ok.map((r) => (r.body.d1 && r.body.d1.colos) || {}));

  return {
    dbKey: db.key,
    dbLabel: db.label,
    dbObservedRegion: db.observedRegion,
    placement,
    requestCount: requests.length,
    successCount: ok.length,
    errorCount: requests.length - ok.length,
    avg: average(totals),
    p50: percentile(totals, 50),
    p90: percentile(totals, 90),
    p95: percentile(totals, 95),
    p99: percentile(totals, 99),
    min: min(totals),
    max: max(totals),
    stddev: stddev(totals),
    avgPerQuery: average(perQuery),
    avgSqlMs: average(sqlDurations),
    workerColos,
    d1Regions,
    d1Colos,
  };
}

// --- stats helpers (kept in parity with d1-placement-benchmark.mjs) ---------

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function percentile(values, p) {
  const sorted = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function average(values) {
  const valid = values.filter(isFiniteNumber);
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function stddev(values) {
  const valid = values.filter(isFiniteNumber);
  if (valid.length < 2) return 0;
  const avg = average(valid);
  const variance = valid.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (valid.length - 1);
  return Math.sqrt(variance);
}

function min(values) {
  const valid = values.filter(isFiniteNumber);
  return valid.length ? Math.min(...valid) : null;
}

function max(values) {
  const valid = values.filter(isFiniteNumber);
  return valid.length ? Math.max(...valid) : null;
}

function compareNullable(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function mergeCounts(objects) {
  const result = {};
  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj || {})) {
      if (key === "undefined" || key === "null") continue;
      result[key] = (result[key] || 0) + (Number(value) || 0);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function renderHtml(model) {
  const dataJson = JSON.stringify(model).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>D1 Placement Benchmark — Analytics</title>
<style>${STYLE}</style>
</head>
<body>
<div id="app"></div>
<script id="report-data" type="application/json">${dataJson}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const STYLE = `
:root {
  --bg: #0f1419;
  --panel: #171c24;
  --panel-2: #1e2530;
  --border: #2a323e;
  --text: #e6edf3;
  --muted: #8b98a8;
  --accent: #f6821f;
  --accent-2: #4a9eff;
  --good: #2ea043;
  --bad: #e5534b;
  --shadow: 0 1px 3px rgba(0,0,0,.4);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
}
.wrap { max-width: 1180px; margin: 0 auto; padding: 28px 20px 80px; }
h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -.2px; }
h2 { font-size: 16px; margin: 28px 0 12px; letter-spacing: -.1px; }
.sub { color: var(--muted); font-size: 13px; margin: 0 0 20px; }
a { color: var(--accent-2); text-decoration: none; }
a:hover { text-decoration: underline; }

.meta { display: flex; flex-wrap: wrap; gap: 10px 22px; color: var(--muted); font-size: 12.5px; margin-bottom: 18px; }
.meta b { color: var(--text); font-weight: 600; }

.banner {
  background: linear-gradient(135deg, rgba(246,130,31,.14), rgba(74,158,255,.10));
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 18px;
  display: flex; align-items: center; gap: 14px;
  margin-bottom: 22px;
}
.banner .star { font-size: 26px; }
.banner .title { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.banner .pair { font-size: 18px; font-weight: 700; margin-top: 2px; }
.banner .pair .d1 { color: var(--accent); }
.banner .pair .wk { color: var(--accent-2); }
.banner .nums { margin-left: auto; text-align: right; color: var(--muted); font-size: 12.5px; }
.banner .nums b { color: var(--text); font-size: 15px; }

.controls {
  display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-end;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 14px 16px; margin-bottom: 22px;
}
.control { display: flex; flex-direction: column; gap: 5px; }
.control label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
select {
  background: var(--panel-2); color: var(--text);
  border: 1px solid var(--border); border-radius: 7px;
  padding: 8px 10px; font-size: 13.5px; min-width: 180px;
  appearance: none; cursor: pointer;
}
select:focus { outline: none; border-color: var(--accent-2); }
.hint { color: var(--muted); font-size: 12px; max-width: 360px; }

.panel {
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 4px 0; margin-bottom: 24px; overflow: hidden;
}
.panel .pad { padding: 14px 16px; }

table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 9px 12px; text-align: right; white-space: nowrap; }
th:first-child, td:first-child,
th.l, td.l { text-align: left; }
thead th {
  color: var(--muted); font-weight: 600; font-size: 11.5px;
  text-transform: uppercase; letter-spacing: .04em;
  border-bottom: 1px solid var(--border); cursor: pointer; user-select: none;
}
thead th:hover { color: var(--text); }
tbody tr { border-bottom: 1px solid rgba(42,50,62,.5); }
tbody tr:last-child { border-bottom: none; }
tbody tr:hover { background: rgba(74,158,255,.06); }
tbody tr.best { background: rgba(46,160,67,.10); }
td.metric { font-variant-numeric: tabular-nums; font-weight: 600; }
.tag {
  display: inline-block; padding: 2px 7px; border-radius: 5px;
  font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;
}
.tag.d1 { background: rgba(246,130,31,.16); color: #ffb066; }
.tag.wk { background: rgba(74,158,255,.16); color: #8fc0ff; }
.tag.win { background: rgba(46,160,67,.18); color: #5ed27a; }
.muted { color: var(--muted); }
.rank { color: var(--muted); font-variant-numeric: tabular-nums; }
.colos { color: var(--muted); font-size: 11.5px; }

/* heatmap matrix */
.matrix-scroll { overflow-x: auto; }
table.matrix th.col { text-align: center; min-width: 92px; }
table.matrix td.cell { text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; cursor: default; position: relative; }
table.matrix td.cell .v { position: relative; z-index: 1; }
table.matrix td.cell.win { box-shadow: inset 0 0 0 2px var(--good); border-radius: 4px; }
table.matrix td.cell.na { color: var(--muted); font-weight: 400; }
table.matrix th.rowhead { text-align: left; }

.legend { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; padding: 0 16px 12px; }
.legend .bar { height: 10px; width: 160px; border-radius: 5px; background: linear-gradient(90deg, #1f9c4d, #d8c531, #d9534f); }

.bars { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; }
.barrow { display: grid; grid-template-columns: 160px 1fr 86px; align-items: center; gap: 12px; }
.barrow .name { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; }
.barrow .track { background: var(--panel-2); border-radius: 6px; height: 22px; overflow: hidden; }
.barrow .fill { height: 100%; border-radius: 6px; }
.barrow .val { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; font-size: 12.5px; }
.barrow.best .name { color: #5ed27a; font-weight: 600; }

.empty { padding: 28px 16px; color: var(--muted); text-align: center; }
.foot { color: var(--muted); font-size: 12px; margin-top: 30px; line-height: 1.7; }
.foot code { background: var(--panel-2); padding: 1px 5px; border-radius: 4px; }
`;

const SCRIPT = `
"use strict";
const MODEL = JSON.parse(document.getElementById("report-data").textContent);
const METRICS = [
  { key: "avg", label: "Average" },
  { key: "p50", label: "p50 (median)" },
  { key: "p90", label: "p90" },
  { key: "p95", label: "p95" },
  { key: "p99", label: "p99" },
  { key: "min", label: "Min" },
  { key: "max", label: "Max" },
];
const state = { db: "all", metric: "p95", sort: "metric", dir: 1 };

function fmt(v) { return v == null ? "—" : v.toFixed(v < 10 ? 1 : 0) + "ms"; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function counts(obj) {
  const e = Object.entries(obj || {});
  if (!e.length) return "—";
  return e.sort((a,b)=>b[1]-a[1]).map(([k,v]) => k + ":" + v).join(", ");
}
function lerpColor(t) {
  // 0 = fast/green, 1 = slow/red, via amber midpoint
  t = Math.max(0, Math.min(1, t));
  const stops = [[31,156,77],[216,197,49],[217,83,79]];
  const seg = t < .5 ? 0 : 1;
  const lt = t < .5 ? t/.5 : (t-.5)/.5;
  const a = stops[seg], b = stops[seg+1];
  const c = a.map((x,i)=>Math.round(x+(b[i]-x)*lt));
  return "rgb(" + c.join(",") + ")";
}
function dbLabel(key) {
  const d = MODEL.databases.find(d => d.key === key);
  if (!d) return key;
  return d.observedRegion ? d.label + " (" + d.observedRegion + ")" : d.label;
}

function render() {
  const app = document.getElementById("app");
  app.innerHTML =
    header() +
    banner() +
    controls() +
    (state.db === "all" ? matrixPanel() + globalTablePanel() : regionPanel()) +
    footer();
  wire();
}

function header() {
  const r = MODEL.run;
  const range = r.startedAt && r.completedAt
    ? new Date(r.startedAt).toLocaleString() + " → " + new Date(r.completedAt).toLocaleString()
    : "—";
  return '<div class="wrap-inner">' +
    '<h1>D1 Placement Benchmark — Analytics</h1>' +
    '<p class="sub">Worker-to-D1 latency measured inside each Worker. Lower is better.</p>' +
    '<div class="meta">' +
      '<span><b>' + MODEL.databases.length + '</b> D1 regions</span>' +
      '<span><b>' + MODEL.placements.length + '</b> Worker placements</span>' +
      '<span><b>' + MODEL.pairs.length + '</b> pairs tested</span>' +
      '<span>Run: <b>' + esc(r.id || "—") + '</b></span>' +
      '<span>' + esc(range) + '</span>' +
    '</div></div>';
}

function banner() {
  if (!MODEL.best) return "";
  const p = MODEL.pairs.find(x => x.dbKey === MODEL.best.dbKey && x.placement === MODEL.best.placement);
  if (!p) return "";
  return '<div class="banner">' +
    '<div class="star">🏆</div>' +
    '<div>' +
      '<div class="title">Best global pair (lowest p95)</div>' +
      '<div class="pair"><span class="d1">D1 ' + esc(dbLabel(p.dbKey)) + '</span>' +
        ' <span class="muted">×</span> <span class="wk">' + esc(p.placement) + '</span></div>' +
    '</div>' +
    '<div class="nums">' +
      '<b>' + fmt(p.p95) + '</b> p95 &nbsp;·&nbsp; ' + fmt(p.avg) + ' avg &nbsp;·&nbsp; ' + fmt(p.p50) + ' p50' +
    '</div>' +
  '</div>';
}

function controls() {
  let dbOpts = '<option value="all">All D1 regions</option>';
  for (const d of MODEL.databases) {
    dbOpts += '<option value="' + esc(d.key) + '"' + (state.db === d.key ? " selected" : "") + '>' +
      esc(dbLabel(d.key)) + '</option>';
  }
  let mOpts = "";
  for (const m of METRICS) {
    mOpts += '<option value="' + m.key + '"' + (state.metric === m.key ? " selected" : "") + '>' + m.label + '</option>';
  }
  const hint = state.db === "all"
    ? "Showing every D1 region. Pick a region to find its best Worker placement."
    : "Filtered to one D1 region — the top Worker placement is its recommended pairing.";
  return '<div class="controls">' +
    '<div class="control"><label>D1 region filter</label><select id="dbSel">' + dbOpts + '</select></div>' +
    '<div class="control"><label>Compare by metric</label><select id="mSel">' + mOpts + '</select></div>' +
    '<div class="hint">' + hint + '</div>' +
  '</div>';
}

function metricVal(p) { return p[state.metric]; }

function matrixPanel() {
  const dbs = MODEL.databases;
  const pls = MODEL.placements;
  const vals = MODEL.pairs.map(metricVal).filter(v => v != null);
  const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  const span = hi - lo || 1;
  // best worker per db (min metric) for highlighting
  const bestByDb = {};
  for (const d of dbs) {
    let best = null;
    for (const p of MODEL.pairs.filter(x => x.dbKey === d.key && metricVal(x) != null)) {
      if (!best || metricVal(p) < metricVal(best)) best = p;
    }
    if (best) bestByDb[d.key] = best.placement;
  }
  let head = '<tr><th class="rowhead l">D1 region ＼ Worker</th>';
  for (const pl of pls) head += '<th class="col">' + esc(pl) + '</th>';
  head += '</tr>';
  let rows = "";
  for (const d of dbs) {
    rows += '<tr><th class="rowhead l"><span class="tag d1">' + esc(dbLabel(d.key)) + '</span></th>';
    for (const pl of pls) {
      const p = MODEL.pairs.find(x => x.dbKey === d.key && x.placement === pl);
      const v = p ? metricVal(p) : null;
      if (v == null) { rows += '<td class="cell na">—</td>'; continue; }
      const t = (v - lo) / span;
      const bg = lerpColor(t);
      const win = bestByDb[d.key] === pl;
      rows += '<td class="cell' + (win ? " win" : "") + '" style="background:' + bg + '22" title="' +
        esc(dbLabel(d.key)) + ' × ' + esc(pl) + ': ' + fmt(v) + '">' +
        '<span class="v" style="color:' + bg + '">' + fmt(v) + '</span></td>';
    }
    rows += '</tr>';
  }
  return '<h2>Latency matrix — ' + metricLabel() + '</h2>' +
    '<div class="panel">' +
      '<div class="matrix-scroll"><table class="matrix"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="legend"><span>faster</span><span class="bar"></span><span>slower</span>' +
        '<span style="margin-left:14px">green outline = best Worker for that D1 region</span></div>' +
    '</div>';
}

function metricLabel() {
  return (METRICS.find(m => m.key === state.metric) || {}).label || state.metric;
}

function sortedPairs(pairs) {
  const dir = state.dir;
  const key = state.sort;
  const cmp = (a, b) => {
    let av, bv;
    if (key === "db") { av = dbLabel(a.dbKey); bv = dbLabel(b.dbKey); return av.localeCompare(bv) * dir; }
    if (key === "placement") return a.placement.localeCompare(b.placement) * dir;
    if (key === "metric") { av = metricVal(a); bv = metricVal(b); }
    else { av = a[key]; bv = b[key]; }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * dir;
  };
  return pairs.slice().sort(cmp);
}

function tableHead(cols) {
  return '<tr>' + cols.map(c =>
    '<th class="' + (c.l ? "l " : "") + '" data-sort="' + c.key + '">' + c.label +
      (state.sort === c.key ? (state.dir === 1 ? " ▲" : " ▼") : "") + '</th>'
  ).join("") + '</tr>';
}

function globalTablePanel() {
  const cols = [
    { key: "db", label: "D1 region", l: true },
    { key: "placement", label: "Worker placement", l: true },
    { key: "metric", label: metricLabel() },
    { key: "avg", label: "Avg" },
    { key: "p50", label: "p50" },
    { key: "p95", label: "p95" },
    { key: "p99", label: "p99" },
    { key: "avgPerQuery", label: "Avg/query" },
    { key: "errorCount", label: "Errors" },
  ];
  const pairs = sortedPairs(MODEL.pairs);
  const bestKey = MODEL.best ? MODEL.best.dbKey + "|" + MODEL.best.placement : null;
  let rows = "";
  for (const p of pairs) {
    const isBest = bestKey === p.dbKey + "|" + p.placement;
    rows += '<tr class="' + (isBest ? "best" : "") + '">' +
      '<td class="l"><span class="tag d1">' + esc(dbLabel(p.dbKey)) + '</span></td>' +
      '<td class="l"><span class="tag wk">' + esc(p.placement) + '</span>' + (isBest ? ' <span class="tag win">best</span>' : '') + '</td>' +
      '<td class="metric">' + fmt(metricVal(p)) + '</td>' +
      '<td>' + fmt(p.avg) + '</td>' +
      '<td>' + fmt(p.p50) + '</td>' +
      '<td>' + fmt(p.p95) + '</td>' +
      '<td>' + fmt(p.p99) + '</td>' +
      '<td>' + fmt(p.avgPerQuery) + '</td>' +
      '<td class="' + (p.errorCount ? "" : "muted") + '">' + p.errorCount + '</td>' +
    '</tr>';
  }
  if (!rows) rows = '<tr><td colspan="9" class="empty">No successful measurements.</td></tr>';
  return '<h2>All pairs ranked</h2>' +
    '<div class="panel"><table id="ptable"><thead>' + tableHead(cols) + '</thead><tbody>' + rows + '</tbody></table></div>';
}

function regionPanel() {
  const d = MODEL.databases.find(x => x.key === state.db);
  const pairs = MODEL.pairs.filter(p => p.dbKey === state.db);
  const usable = pairs.filter(p => metricVal(p) != null);
  if (!usable.length) {
    return '<div class="panel"><div class="empty">No successful measurements for this D1 region.</div></div>';
  }
  const ranked = usable.slice().sort((a, b) => metricVal(a) - metricVal(b));
  const winner = ranked[0];
  const worst = Math.max.apply(null, ranked.map(metricVal));

  // recommendation banner for this region
  const rec = '<div class="banner">' +
    '<div class="star">✅</div>' +
    '<div><div class="title">Best Worker for D1 ' + esc(dbLabel(d.key)) + ' (lowest ' + metricLabel() + ')</div>' +
      '<div class="pair"><span class="wk">' + esc(winner.placement) + '</span></div></div>' +
    '<div class="nums"><b>' + fmt(metricVal(winner)) + '</b> ' + metricLabel().toLowerCase() +
      ' &nbsp;·&nbsp; ' + fmt(winner.avg) + ' avg</div>' +
  '</div>';

  // bar chart
  let bars = "";
  for (const p of ranked) {
    const v = metricVal(p);
    const w = Math.max(2, (v / worst) * 100);
    const t = ranked.length > 1 ? (v - metricVal(winner)) / ((worst - metricVal(winner)) || 1) : 0;
    const col = lerpColor(t);
    const isBest = p === winner;
    bars += '<div class="barrow ' + (isBest ? "best" : "") + '">' +
      '<div class="name">' + esc(p.placement) + (isBest ? ' 🏆' : '') + '</div>' +
      '<div class="track"><div class="fill" style="width:' + w + '%;background:' + col + '"></div></div>' +
      '<div class="val">' + fmt(v) + '</div>' +
    '</div>';
  }

  // detail table
  const cols = [
    { key: "placement", label: "Worker placement", l: true },
    { key: "metric", label: metricLabel() },
    { key: "avg", label: "Avg" },
    { key: "p50", label: "p50" },
    { key: "p90", label: "p90" },
    { key: "p95", label: "p95" },
    { key: "p99", label: "p99" },
    { key: "min", label: "Min" },
    { key: "max", label: "Max" },
    { key: "stddev", label: "Stddev" },
    { key: "avgPerQuery", label: "Avg/query" },
    { key: "errorCount", label: "Errors" },
  ];
  const tablePairs = sortedPairs(pairs);
  let rows = "";
  for (const p of tablePairs) {
    const isBest = p === winner;
    rows += '<tr class="' + (isBest ? "best" : "") + '">' +
      '<td class="l"><span class="tag wk">' + esc(p.placement) + '</span>' + (isBest ? ' <span class="tag win">best</span>' : '') + '</td>' +
      '<td class="metric">' + fmt(metricVal(p)) + '</td>' +
      '<td>' + fmt(p.avg) + '</td>' +
      '<td>' + fmt(p.p50) + '</td>' +
      '<td>' + fmt(p.p90) + '</td>' +
      '<td>' + fmt(p.p95) + '</td>' +
      '<td>' + fmt(p.p99) + '</td>' +
      '<td>' + fmt(p.min) + '</td>' +
      '<td>' + fmt(p.max) + '</td>' +
      '<td>' + fmt(p.stddev) + '</td>' +
      '<td>' + fmt(p.avgPerQuery) + '</td>' +
      '<td class="' + (p.errorCount ? "" : "muted") + '">' + p.errorCount + '</td>' +
    '</tr>';
  }
  const dbMeta = '<div class="pad muted" style="font-size:12.5px">' +
    'Database: <b style="color:var(--text)">' + esc(d.name || "—") + '</b> &nbsp;·&nbsp; ' +
    'Target hint: ' + esc(d.targetLocation || "—") + ' &nbsp;·&nbsp; ' +
    'Observed region: ' + esc(d.observedRegion || "—") +
  '</div>';

  return rec +
    '<h2>Worker placements for D1 ' + esc(dbLabel(d.key)) + ' — ' + metricLabel() + '</h2>' +
    '<div class="panel"><div class="bars">' + bars + '</div></div>' +
    '<h2>Detailed stats</h2>' +
    '<div class="panel">' + dbMeta + '<div class="matrix-scroll"><table id="ptable"><thead>' + tableHead(cols) +
      '</thead><tbody>' + rows + '</tbody></table></div></div>';
}

function footer() {
  const warns = (MODEL.run.warnings || []).map(w => '<div>⚠️ ' + esc(w) + '</div>').join("");
  return '<div class="foot">' + warns +
    '<div>Timings are measured inside the Worker around D1 calls, not client-to-Worker.</div>' +
    '<div>Worker placement uses Wrangler targeted placement (<code>placement.region = "provider:region"</code>).</div>' +
    '<div>Generated ' + esc(MODEL.generatedAt) + '.</div>' +
  '</div>';
}

function wire() {
  const dbSel = document.getElementById("dbSel");
  const mSel = document.getElementById("mSel");
  if (dbSel) dbSel.onchange = e => { state.db = e.target.value; state.sort = "metric"; state.dir = 1; render(); };
  if (mSel) mSel.onchange = e => { state.metric = e.target.value; render(); };
  document.querySelectorAll("th[data-sort]").forEach(th => {
    th.onclick = () => {
      const key = th.getAttribute("data-sort");
      if (state.sort === key) state.dir *= -1;
      else { state.sort = key; state.dir = 1; }
      render();
    };
  });
}

// wrap content for max-width consistency
document.getElementById("app").className = "wrap";
render();
`;
