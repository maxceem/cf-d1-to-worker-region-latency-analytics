#!/usr/bin/env node
// Build a self-contained, interactive static website from a benchmark
// raw.json file. Lets you compare Worker placements per D1 region, see the whole
// matrix at once, or filter down to a single D1 region to pick its best Worker.
//
// Usage:
//   node ./src/build-html-site.mjs [--input results/raw.json] [--output docs/index.html]
//
// Defaults: reads the newest available raw.json and writes docs/index.html.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getMinSuccessfulRequests,
  getPairMeasurements,
  isPairReliable
} from "./placement-eligibility.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const MetricStats = require("./metric-stats.cjs");
const { average, isFiniteNumber, numberOrNull } = MetricStats;

// Public repository URL shown in the report's "Source" link. Update before deploy.
const REPO_URL = "https://github.com/maxceem/cf-d1-to-worker-region-latency-analytics";
const DEFAULT_OUTPUT_PATH = "docs/index.html";

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
  const [basemap, d1LocationCoordinates, providerRegionCoordinates, workerColoCoordinates] = await Promise.all([
    readJson("data/world-basemap.json"),
    readJson("data/d1-location-coordinates.json"),
    readJson("data/provider-region-coordinates.json"),
    readJson("data/worker-colo-coordinates.json"),
  ]);
  const model = buildModel(raw);
  model.basemap = basemap;
  model.d1coords = d1LocationCoordinates;
  model.coords = providerRegionCoordinates;
  model.coloCoords = workerColoCoordinates;
  model.repoUrl = REPO_URL;
  const exploreDataModel = buildRawModel(raw);
  exploreDataModel.repoUrl = REPO_URL;

  const outputPath = resolvePath(args.output || DEFAULT_OUTPUT_PATH);
  const exploreDataOutputPath = resolve(dirname(outputPath), "explore-data.html");
  const html = await renderHtml(model, {
    scriptName: "script.js",
    title: "Cloudflare D1-to-Worker Latency Analytics",
    page: "overview"
  });
  const exploreDataHtml = await renderHtml(exploreDataModel, {
    scriptName: "explore-data-script.js",
    title: "Explore Data | Cloudflare D1-to-Worker Latency Analytics",
    page: "explore-data"
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf8");
  await writeFile(exploreDataOutputPath, exploreDataHtml, "utf8");

  console.log(`Wrote ${outputPath}`);
  console.log(`Wrote ${exploreDataOutputPath}`);
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
  console.log(`Build an interactive static website from benchmark raw data.

Usage:
  node ./src/build-html-site.mjs [--input <raw.json>] [--output <docs/index.html>]

Options:
  -i, --input   Path to raw.json (default: newest of results/raw.json and results-partial/raw.json)
  -o, --output  Path to write the HTML file (default: docs/index.html)
      --no-open Do not open the generated site in a browser
  -h, --help    Show this help`);
}

async function resolveInputPath(explicit) {
  if (explicit) return resolvePath(explicit);
  const candidates = [];
  for (const relativePath of ["results/raw.json", "results-partial/raw.json"]) {
    const full = resolvePath(relativePath);
    try {
      const info = await stat(full);
      candidates.push({ full, mtimeMs: info.mtimeMs });
    } catch {
      // try next
    }
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0].full;
  }
  // Default to results/raw.json so the error message is sensible.
  return resolvePath("results/raw.json");
}

function resolvePath(value) {
  return isAbsolute(value) ? value : resolve(rootDir, value);
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(rootDir, path), "utf8"));
}

// ---------------------------------------------------------------------------
// Model: turn raw measurements into per-pair statistics the page can render.
// ---------------------------------------------------------------------------

function buildModel(raw) {
  const run = raw.run || {};
  const minSuccessfulRequests = getMinSuccessfulRequests(run.config);
  const databases = (raw.databases || []).map((db) => ({
    key: db.key,
    label: db.label || db.key,
    name: db.name || null,
    targetLocation: db.targetLocation || null,
    observedRegion: db.observedRegion || null,
    d1Colo: observedD1Colos(raw, db.key)[0] || null,
    d1Colos: observedD1Colos(raw, db.key),
  }));
  const placements = raw.workerPlacements || [];

  const measured = raw.measured || {};
  const pairs = [];
  for (const db of databases) {
    const byPlacement = measured[db.key] || {};
    for (const placement of placements) {
      const requests = byPlacement[placement] || [];
      pairs.push(summarizePair(db, placement, requests, {
        minSuccessfulRequests
      }));
    }
  }

  // Global ranking across every D1 x Worker pair.
  const ranked = pairs
    .filter((p) => p.status === "ok")
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
      benchmark: serializeBenchmarkConfig(run.config && run.config.benchmark),
      minSuccessfulRequests,
    },
    databases,
    placements,
    pairs,
    best: best ? { dbKey: best.dbKey, placement: best.placement } : null,
  };
}

function buildRawModel(raw) {
  const run = raw.run || {};
  const databases = (raw.databases || []).map((db) => ({
    key: db.key,
    label: db.label || db.key,
    targetLocation: db.targetLocation || null,
    observedRegion: db.observedRegion || null,
    d1Colo: observedD1Colos(raw, db.key)[0] || null,
    d1Colos: observedD1Colos(raw, db.key),
  }));
  const databaseByKey = Object.fromEntries(databases.map((db) => [db.key, db]));
  const minSuccessfulRequests = getMinSuccessfulRequests(run.config);
  const rows = [];

  for (const [dbKey, byPlacement] of Object.entries(raw.measured || {})) {
    const db = databaseByKey[dbKey];
    if (!db) continue;
    for (const [placement, requests] of Object.entries(byPlacement || {})) {
      const measurements = getPairMeasurements({ requests, database: db });
      requests.forEach((request, requestIndex) => {
        rows.push(...rawQueryRows({ db, placement, request, requestIndex, measurements }));
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    run: {
      id: run.id || null,
      startedAt: run.startedAt || null,
      completedAt: run.completedAt || null,
      benchmark: serializeBenchmarkConfig(run.config && run.config.benchmark),
      minSuccessfulRequests,
    },
    databases,
    placements: raw.workerPlacements || [],
    rows,
  };
}

function rawQueryRows({ db, placement, request, requestIndex, measurements }) {
  const body = request?.body || {};
  const ok = !!request?.ok && !!request?.body;
  const notes = measurements.notes.get(request) || (ok ? [] : ["failed"]);
  const status = ok ? "ok" : "failed";
  const adjusted = ok ? adjustedTotalMs(body) : null;
  const perQuery = ok ? adjustedPerQueryMs(body) : [];
  const queryValues = perQuery
    .map((value, queryIndex) => ({ value, queryIndex }))
    .filter((entry) => isFiniteNumber(entry.value));
  const rows = queryValues.length ? queryValues : [{ value: adjusted, queryIndex: null }];

  return rows.map(({ value, queryIndex }) => ({
    id: `${db.key}|${placement}|${requestIndex}|${queryIndex == null ? "request" : queryIndex}`,
    dbKey: db.key,
    dbLabel: db.observedRegion || db.label,
    d1TargetLocation: db.targetLocation,
    d1ObservedRegion: db.observedRegion,
    placement,
    requestIndex,
    queryIndex,
    status,
    note: notes.join(", ") || null,
    notes,
    measuredQueryCount: isFiniteNumber(value) ? 1 : 0,
    httpStatus: request?.status || 0,
    clientMs: numberOrNull(request?.clientMs),
    workerColo: body.workerColo || null,
    placementHeader: request?.placementHeader || null,
    placementMode: request?.placementMode || null,
    placementColo: request?.placementColo || null,
    totalMs: numberOrNull(body.totalMs),
    networkMs: numberOrNull(value),
    requestNetworkMs: numberOrNull(adjusted),
    queries: Number.isFinite(body.queries) ? body.queries : null,
    d1Region: queryLocationValue(body.d1?.regions, queryIndex),
    d1Colo: queryLocationValue(body.d1?.colos, queryIndex),
    d1Regions: body.d1?.regions || {},
    d1Colos: body.d1?.colos || {},
    sqlMs: average((body.d1?.sqlDurations || []).filter(isFiniteNumber)),
    error: request?.error || null,
  }));
}

function queryLocationValue(counts, queryIndex) {
  const entries = Object.entries(counts || {});
  if (!entries.length) return null;
  if (entries.length === 1) return entries[0][0];
  if (queryIndex != null) {
    let offset = queryIndex;
    for (const [value, count] of entries) {
      offset -= count;
      if (offset < 0) return value;
    }
  }
  return entries.map(([value]) => value).join("+");
}

function serializeBenchmarkConfig(benchmark) {
  if (!benchmark || typeof benchmark !== "object" || Array.isArray(benchmark)) return null;
  return {
    warmupRequests: benchmark.warmupRequests,
    measuredRequests: benchmark.measuredRequests,
    minSuccessfulRequests: benchmark.minSuccessfulRequests,
    queriesPerRequest: benchmark.queriesPerRequest,
    requestTimeoutMs: benchmark.requestTimeoutMs,
  };
}

function summarizePair(db, placement, requests, { minSuccessfulRequests }) {
  const measurements = getPairMeasurements({ requests, database: db });
  const successful = measurements.successful;
  const reliable = isPairReliable(successful.length, minSuccessfulRequests);
  const rawTotals = reliable ? successful.map((r) => r.body.totalMs).filter(isFiniteNumber) : [];
  const perQuery = reliable ? successful.flatMap((r) => adjustedPerQueryMs(r.body)).filter(isFiniteNumber) : [];
  const rawPerQuery = reliable ? successful.flatMap((r) => r.body.perQueryMs || []).filter(isFiniteNumber) : [];
  const sqlDurations = reliable ? successful
    .flatMap((r) => (r.body.d1 && r.body.d1.sqlDurations) || [])
    .filter(isFiniteNumber) : [];
  const metricStats = reliable
    ? MetricStats.twoStepMetricStats(successful.map((request) => adjustedPerQueryMs(request.body)))
    : MetricStats.emptyMetricStats();

  const workerColos = mergeCounts(successful.map((r) => ({ [r.body.workerColo]: 1 })));
  const placementColos = mergeCounts(successful.map((r) => ({ [r.placementColo]: 1 })));
  const d1Regions = mergeCounts(successful.map((r) => (r.body.d1 && r.body.d1.regions) || {}));
  const d1Colos = mergeCounts(successful.map((r) => (r.body.d1 && r.body.d1.colos) || {}));

  return {
    dbKey: db.key,
    dbLabel: db.label,
    dbObservedRegion: db.observedRegion,
    placement,
    requestCount: requests.length,
    httpSuccessCount: successful.length,
    successCount: successful.length,
    noteCounts: measurements.noteCounts,
    minSuccessfulRequests,
    successRatio: requests.length ? successful.length / requests.length : 0,
    status: reliable ? "ok" : "failed",
    errorCount: measurements.failed.length,
    avg: metricStats.avg,
    p50: metricStats.p50,
    p90: metricStats.p90,
    p95: metricStats.p95,
    p99: metricStats.p99,
    min: metricStats.min,
    max: metricStats.max,
    stddev: metricStats.stddev,
    measuredQueryCount: perQuery.length,
    avgRaw: average(rawTotals),
    avgRawPerQuery: average(rawPerQuery),
    avgSqlMs: average(sqlDurations),
    placementColos,
    workerColos,
    d1Regions,
    d1Colos,
  };
}

function observedD1Colos(raw, dbKey) {
  const counts = {};
  for (const requests of Object.values(raw.measured?.[dbKey] || {})) {
    for (const request of requests || []) {
      for (const [colo, count] of Object.entries(request?.body?.d1?.colos || {})) {
        if (!colo) continue;
        counts[colo] = (counts[colo] || 0) + (Number(count) || 0);
      }
    }
  }
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([colo]) => colo);
}

function adjustedTotalMs(body) {
  if (isFiniteNumber(body?.totalNetworkMs)) return body.totalNetworkMs;
  const adjusted = adjustedPerQueryMs(body);
  if (adjusted.length > 0) return adjusted.reduce((sum, value) => sum + value, 0);
  return body?.totalMs;
}

function adjustedPerQueryMs(body) {
  if (Array.isArray(body?.perQueryNetworkMs) && body.perQueryNetworkMs.length > 0) {
    return body.perQueryNetworkMs;
  }

  const perQuery = Array.isArray(body?.perQueryMs) ? body.perQueryMs : [];
  const sqlDurations = Array.isArray(body?.d1?.sqlDurations) ? body.d1.sqlDurations : [];
  return perQuery.map((value, index) => {
    const sqlDuration = sqlDurations[index];
    return isFiniteNumber(value) && isFiniteNumber(sqlDuration) ? Math.max(0, value - sqlDuration) : value;
  });
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

const TEMPLATE_DIR = resolve(rootDir, "data/site-template");
const ROW_CHUNK_SIZE = 1000;

async function renderHtml(model, { scriptName, title, page }) {
  const [template, siteHeaderTemplate, style, metricStatsScript, commonScript, script, clusterizeScript] = await Promise.all([
    readFile(resolve(TEMPLATE_DIR, "index.html"), "utf8"),
    readFile(resolve(TEMPLATE_DIR, "site-header.html"), "utf8"),
    readFile(resolve(TEMPLATE_DIR, "style.css"), "utf8"),
    readFile(resolve(rootDir, "src/metric-stats.cjs"), "utf8"),
    readFile(resolve(TEMPLATE_DIR, "common.js"), "utf8"),
    readFile(resolve(TEMPLATE_DIR, scriptName), "utf8"),
    page === "explore-data" ? readFile(resolve(rootDir, "node_modules/clusterize.js/clusterize.min.js"), "utf8") : Promise.resolve(""),
  ]);
  const dataBlocks = renderDataBlocks(model, page);
  const pageValues = {
    repoUrl: escapeHtmlAttr(REPO_URL),
    overviewHref: page === "overview" ? "#" : "index.html",
    exploreDataHref: page === "explore-data" ? "#" : "explore-data.html",
    overviewClass: page === "overview" ? "active" : "",
    exploreDataClass: page === "explore-data" ? "active" : "",
  };
  const bundledScript = [
    browserMetricStatsScript(metricStatsScript),
    page === "explore-data" ? clusterizeScript.trimEnd() : "",
    commonScript.trimEnd(),
    script.trimEnd(),
  ].filter(Boolean).join("\n");

  return fillTemplate(template, {
    title: escapeHtml(title),
    dataJson: dataBlocks.dataJson,
    extraDataScripts: dataBlocks.extraDataScripts,
    siteHeader: fillTemplate(siteHeaderTemplate, pageValues),
    script: "\n" + bundledScript + "\n",
    style: "\n" + style.trimEnd() + "\n",
  });
}

function renderDataBlocks(model, page) {
  if (page !== "explore-data") {
    return {
      dataJson: safeJson(model),
      extraDataScripts: "",
    };
  }

  const rows = model.rows || [];
  const initialModel = {
    ...model,
    rows: [],
    rowCounts: rawRowCounts(rows),
    filterFacets: rawFilterFacets(rows),
  };
  const scripts = [];
  for (let i = 0; i < rows.length; i += ROW_CHUNK_SIZE) {
    scripts.push(
      '<script type="application/json" data-report-rows>' +
        safeJson(rows.slice(i, i + ROW_CHUNK_SIZE)) +
      '</script>'
    );
  }

  return {
    dataJson: safeJson(initialModel),
    extraDataScripts: scripts.join("\n"),
  };
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function rawRowCounts(rows) {
  return {
    pair: rawPairRows(rows).length,
    request: rawRequestRows(rows).length,
    query: rows.length,
  };
}

function rawFilterFacets(rows) {
  return {
    pair: rawFacetCounts(rawPairRows(rows)),
    request: rawFacetCounts(rawRequestRows(rows)),
    query: rawFacetCounts(rows),
  };
}

function rawFacetCounts(rows) {
  const result = {};
  for (const key of ["db", "placement", "placementColo", "workerColo", "d1Region", "d1Colo", "note"]) {
    result[key] = {};
  }
  for (const row of rows) {
    for (const key of Object.keys(result)) {
      for (const value of rawFilterValues(row, key)) {
        result[key][value] = (result[key][value] || 0) + 1;
      }
    }
  }
  return result;
}

function rawFilterValues(row, key) {
  let values = [];
  if (key === "db") values = [row.dbKey];
  else if (key === "placement") values = [row.placement];
  else if (key === "placementColo") values = [row.placementColo];
  else if (key === "workerColo") values = [row.workerColo];
  else if (key === "d1Region") values = row.d1RegionValues || [row.d1Region];
  else if (key === "d1Colo") values = row.d1ColoValues || [row.d1Colo];
  else if (key === "note") values = rawNoteValues(row);
  return values.map(rawLabelValue);
}

function rawLabelValue(value) {
  return value == null || value === "" ? "(none)" : String(value);
}

function rawNoteValues(row) {
  const values = row.noteValues || row.notes || (row.note ? [row.note] : []);
  return values.length ? values : [null];
}

function rawPairRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row.dbKey + "|" + row.placement;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped.values()].map((rowsForPair) => {
    const first = rowsForPair[0];
    const requests = rawGroupByRequest(rowsForPair);
    const requestValues = requests
      .map(rowsForRequest => MetricStats.reduceMetric(rowsForRequest.map(row => row.networkMs), "p95"))
      .filter(value => value != null);
    const placementColoValues = uniqueValues(rowsForPair.map(row => row.placementColo).filter(Boolean));
    const workerColoValues = uniqueValues(rowsForPair.map(row => row.workerColo).filter(Boolean));
    const d1RegionValues = uniqueValues(rowsForPair.flatMap(row => row.d1RegionValues || [row.d1Region]).filter(Boolean));
    const d1ColoValues = uniqueValues(rowsForPair.flatMap(row => row.d1ColoValues || [row.d1Colo]).filter(Boolean));
    const noteValues = uniqueValues(rowsForPair.flatMap(row => row.notes || (row.note ? [row.note] : [])));
    return {
      dbKey: first.dbKey,
      placement: first.placement,
      placementColo: placementColoValues.join("+") || null,
      workerColo: workerColoValues.join("+") || null,
      d1Region: d1RegionValues.join("+") || null,
      d1Colo: d1ColoValues.join("+") || null,
      placementColoValues,
      workerColoValues,
      d1RegionValues,
      d1ColoValues,
      noteValues,
      note: noteValues.join(", ") || null,
      networkMs: MetricStats.reduceMetric(requestValues, "p95"),
    };
  });
}

function rawRequestRows(rows) {
  return rawGroupByRequest(rows).map((rowsForRequest) => {
    const first = rowsForRequest[0];
    const d1RegionValues = uniqueValues(rowsForRequest.map(row => row.d1Region).filter(Boolean));
    const d1ColoValues = uniqueValues(rowsForRequest.map(row => row.d1Colo).filter(Boolean));
    const noteValues = uniqueValues(rowsForRequest.flatMap(row => row.notes || (row.note ? [row.note] : [])));
    return {
      ...first,
      d1Region: d1RegionValues.join("+") || null,
      d1Colo: d1ColoValues.join("+") || null,
      d1RegionValues,
      d1ColoValues,
      note: noteValues.join(", ") || null,
      noteValues,
    };
  });
}

function rawGroupByRequest(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row.dbKey + "|" + row.placement + "|" + row.requestIndex;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped.values()];
}

function uniqueValues(values) {
  return [...new Set(values.filter(value => value != null && value !== ""))]
    .sort((a, b) => String(a).localeCompare(String(b)));
}

function browserMetricStatsScript(source) {
  return `window.MetricStats = (() => {
const module = { exports: {} };
const exports = module.exports;
${source.trimEnd()}
return module.exports;
})();`;
}

function fillTemplate(template, values) {
  let html = template;
  for (const [key, value] of Object.entries(values)) {
    html = html.split("{{" + key + "}}").join(value);
  }
  return html;
}

function escapeHtmlAttr(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  })[char]);
}
