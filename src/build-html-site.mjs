#!/usr/bin/env node
// Build a self-contained, interactive static website from a benchmark
// raw.json files. Lets you compare Worker placements per D1 region, see the whole
// matrix at once, or filter down to a single D1 region to pick its best Worker.
//
// Usage:
//   node ./src/build-html-site.mjs [--input results/raw.json] [--output docs/index.html]
//   node ./src/build-html-site.mjs results/run-a results/run-b [--output docs/index.html]
//
// Defaults: reads the newest available raw.json and writes docs/index.html.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getMinSuccessfulRequests,
  getPairMeasurements,
  isPairReliable
} from "./placement-eligibility.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const MetricStats = require("./metric-stats.cjs");
const { DEFAULT_AGGREGATE_METRIC, average, isFiniteNumber, numberOrNull } = MetricStats;

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

  const inputPaths = await resolveInputPaths(args.inputs);
  const rawInputs = await readRawInputs(inputPaths);
  const raw = combineRawInputs(rawInputs);
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
  const exploreDataModel = buildRawModel(raw, rawInputs);
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
  const args = { inputs: [], output: null, help: false, open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") args.help = true;
    else if (flag === "--input" || flag === "-i") args.inputs.push(argv[++i]);
    else if (flag === "--output" || flag === "-o") args.output = argv[++i];
    else if (flag === "--no-open") args.open = false;
    else if (flag === "--open") args.open = true;
    else args.inputs.push(flag);
  }
  return args;
}

function printHelp() {
  console.log(`Build an interactive static website from benchmark raw data.

Usage:
  node ./src/build-html-site.mjs [--input <raw.json|run-dir> ...] [--output <docs/index.html>]
  node ./src/build-html-site.mjs <raw.json|run-dir> [raw.json|run-dir ...]

Options:
  -i, --input   Path to raw.json or a results run folder. May be repeated.
  -o, --output  Path to write the HTML file (default: docs/index.html)
      --no-open Do not open the generated site in a browser
  -h, --help    Show this help`);
}

async function resolveInputPaths(explicitInputs) {
  if (explicitInputs.length) return Promise.all(explicitInputs.map(resolveRawInputPath));
  const candidates = [];
  const resultsDir = resolvePath("results");
  try {
    for (const entry of await readdir(resultsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = resolve(resultsDir, entry.name, "raw.json");
      try {
        const info = await stat(full);
        candidates.push({ full, mtimeMs: info.mtimeMs });
      } catch {
        // try next
      }
    }
  } catch {
    // Default to results/raw.json so the error message is sensible.
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return [candidates[0].full];
  }
  return [resolvePath("results/raw.json")];
}

async function resolveRawInputPath(input) {
  const full = resolvePath(input);
  const info = await stat(full);
  return info.isDirectory() ? resolve(full, "raw.json") : full;
}

function resolvePath(value) {
  return isAbsolute(value) ? value : resolve(rootDir, value);
}

async function readRawInputs(inputPaths) {
  return Promise.all(inputPaths.map(async (path, index) => {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return {
      path,
      raw,
      run: buildRunSummary(raw.run || {}, path, index),
    };
  }));
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(rootDir, path), "utf8"));
}

function combineRawInputs(inputs) {
  if (!inputs.length) throw new Error("At least one raw input is required.");
  if (inputs.length === 1) {
    const raw = structuredClone(inputs[0].raw);
    raw.runs = [inputs[0].run];
    raw.run = buildCombinedRun(inputs);
    return raw;
  }

  return {
    run: buildCombinedRun(inputs),
    runs: inputs.map((input) => input.run),
    databases: uniqueBy(inputs.flatMap((input) => input.raw.databases || []), (db) => db.key),
    databaseColocations: uniqueBy(
      inputs.flatMap((input) => input.raw.databaseColocations || []),
      (record) => `${record.key}|${record.coloKey || record.observedColo || "unknown"}`
    ),
    workerPlacements: uniqueValues(inputs.flatMap((input) => input.raw.workerPlacements || [])),
    measured: mergeMeasuredRuns(inputs),
  };
}

function buildCombinedRun(inputs) {
  const runs = inputs.map((input) => input.raw.run || {});
  const startedAt = minIso(runs.map((run) => run.startedAt));
  const completedAt = maxIso(runs.map((run) => run.completedAt));
  return {
    id: inputs.length === 1 ? runs[0].id || inputs[0].run.id : "combined",
    startedAt,
    completedAt,
    accountId: sameValue(runs.map((run) => run.accountId)),
    warnings: uniqueValues(runs.flatMap((run) => run.warnings || [])),
    config: combineRunConfig(runs),
  };
}

function combineRunConfig(runs) {
  const config = structuredClone(runs[0]?.config || {});
  const benchmark = combineBenchmarkConfig(runs.map((run) => run.config?.benchmark || {}));
  return { ...config, benchmark };
}

function combineBenchmarkConfig(benchmarks) {
  const first = benchmarks[0] || {};
  const measuredRequests = sumNumeric(benchmarks.map((benchmark) => benchmark.measuredRequests));
  const minSuccessfulRequests = maxNumeric(benchmarks.map((benchmark) => benchmark.minSuccessfulRequests));
  return {
    ...first,
    warmupRequests: sameValue(benchmarks.map((benchmark) => benchmark.warmupRequests)) ?? first.warmupRequests,
    measuredRequests: measuredRequests ?? first.measuredRequests,
    minSuccessfulRequests: minSuccessfulRequests ?? first.minSuccessfulRequests,
    splitInRounds: sameValue(benchmarks.map((benchmark) => benchmark.splitInRounds)) ?? first.splitInRounds,
    queriesPerRequest: sameValue(benchmarks.map((benchmark) => benchmark.queriesPerRequest)) ?? first.queriesPerRequest,
    requestTimeoutMs: sameValue(benchmarks.map((benchmark) => benchmark.requestTimeoutMs)) ?? first.requestTimeoutMs,
  };
}

function mergeMeasuredRuns(inputs) {
  const measured = {};
  for (const input of inputs) {
    for (const [dbKey, byColo] of Object.entries(input.raw.measured || {})) {
      const targetByColo = measured[dbKey] ||= {};
      for (const [coloKey, byPlacement] of Object.entries(byColo || {})) {
        const targetByPlacement = targetByColo[coloKey] ||= {};
        for (const [placement, requests] of Object.entries(byPlacement || {})) {
          targetByPlacement[placement] ||= [];
          targetByPlacement[placement].push(...(requests || []));
        }
      }
    }
  }
  return measured;
}

function buildRunSummary(run, path, index) {
  const id = run.id || `run-${index + 1}`;
  return {
    id,
    label: id,
    startedAt: run.startedAt || null,
    completedAt: run.completedAt || null,
    sourcePath: relative(rootDir, path),
    benchmark: serializeBenchmarkConfig(run.config && run.config.benchmark),
  };
}

function minIso(values) {
  const times = values.map((value) => Date.parse(value)).filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

function maxIso(values) {
  const times = values.map((value) => Date.parse(value)).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function sameValue(values) {
  const present = values.filter((value) => value != null);
  if (!present.length) return null;
  return present.every((value) => value === present[0]) ? present[0] : null;
}

function sumNumeric(values) {
  const nums = values.filter(isFiniteNumber);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) : null;
}

function maxNumeric(values) {
  const nums = values.filter(isFiniteNumber);
  return nums.length ? Math.max(...nums) : null;
}

function uniqueBy(values, keyFn) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyFn(value);
    if (key == null || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Model: turn raw measurements into per-pair statistics the page can render.
// ---------------------------------------------------------------------------

function buildModel(raw) {
  const run = raw.run || {};
  const minSuccessfulRequests = getMinSuccessfulRequests(run.config);
  const databases = buildDatabaseModels(raw);
  const placements = raw.workerPlacements || [];

  const measured = raw.measured || {};
  const pairs = [];
  for (const db of databases) {
    const byColo = measured[db.key] || {};
    for (const colocatedDb of db.colocations) {
      const byPlacement = byColo[colocatedDb.coloKey] || {};
      for (const placement of placements) {
        const requests = byPlacement[placement] || [];
        pairs.push(summarizePair(colocatedDb, placement, requests, {
          minSuccessfulRequests
        }));
      }
    }
  }

  // Global ranking across every D1 x Worker pair.
  const ranked = pairs
    .filter((p) => p.status === "ok")
    .sort((a, b) => compareNullable(a[DEFAULT_AGGREGATE_METRIC], b[DEFAULT_AGGREGATE_METRIC]) || compareNullable(a.avg, b.avg));
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
    runs: raw.runs || [],
    databases,
    placements,
    pairs,
    best: best ? { dbKey: best.dbKey, d1ColoKey: best.d1ColoKey, placement: best.placement } : null,
  };
}

function buildRawModel(raw, inputs = [{ raw, run: (raw.runs || [buildRunSummary(raw.run || {}, "results/raw.json", 0)])[0] }]) {
  const run = raw.run || {};
  const minSuccessfulRequests = getMinSuccessfulRequests(run.config);
  const databases = buildDatabaseModels(raw);
  const rows = [];

  for (const input of inputs) {
    const inputRaw = input.raw;
    const inputDatabases = buildDatabaseModels(inputRaw);
    const databaseByColoKey = Object.fromEntries(inputDatabases.flatMap((db) =>
      db.colocations.map((colocatedDb) => [`${db.key}|${colocatedDb.coloKey}`, colocatedDb])
    ));
    const minSuccessfulRequests = getMinSuccessfulRequests(inputRaw.run?.config);
    for (const [dbKey, byColo] of Object.entries(inputRaw.measured || {})) {
      for (const [coloKey, byPlacement] of Object.entries(byColo || {})) {
        const db = databaseByColoKey[`${dbKey}|${coloKey}`];
        if (!db) continue;
        for (const [placement, requests] of Object.entries(byPlacement || {})) {
          const measurements = getPairMeasurements({ requests, database: db });
          rows.push(rawExplorePairRow({ db, placement, requests, measurements, minSuccessfulRequests, run: input.run }));
        }
      }
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
    runs: raw.runs || inputs.map((input) => input.run),
    databases,
    placements: raw.workerPlacements || [],
    rows,
  };
}

function buildDatabaseModels(raw) {
  return (raw.databases || []).map((db) => {
    const records = (raw.databaseColocations || []).filter((record) => record.key === db.key);
    const coloKeys = uniqueValues([
      ...records.map((record) => record.coloKey || record.observedColo),
      ...Object.keys(raw.measured?.[db.key] || {})
    ]);
    const d1Colos = observedD1Colos(raw, db.key);
    const colocations = coloKeys.map((coloKey) => {
      const record = records.find((item) => (item.coloKey || item.observedColo) === coloKey) || {};
      const observedColo = record.observedColo || (coloKey === "unknown" ? null : coloKey);
      return {
        key: db.key,
        label: db.label || db.key,
        name: record.name || null,
        targetLocation: db.targetLocation || record.targetLocation || null,
        observedRegion: record.observedRegion || db.observedRegion || null,
        observedColo,
        d1Colo: observedColo,
        d1Colos: observedColo ? [observedColo] : [],
        coloKey,
      };
    });
    return {
      key: db.key,
      label: db.label || db.key,
      name: db.name || null,
      targetLocation: db.targetLocation || null,
      observedRegion: db.observedRegion || records.find((record) => record.observedRegion)?.observedRegion || null,
      d1Colo: d1Colos[0] || null,
      d1Colos,
      colocations,
    };
  });
}

function rawExplorePairRow({ db, placement, requests, measurements, minSuccessfulRequests, run }) {
  const successful = measurements.successful;
  const networkValues = successful.flatMap((request) => {
    const adjusted = adjustedTotalMs(request.body);
    const perQuery = adjustedPerQueryMs(request.body).filter(isFiniteNumber);
    return perQuery.length ? perQuery : isFiniteNumber(adjusted) ? [adjusted] : [];
  });
  const networkStats = networkValues.length ? MetricStats.metricStats(networkValues) : MetricStats.emptyMetricStats();
  const placementColoCounts = mergeCounts(requests.map((request) => ({ [countKey(request.placementColo)]: 1 })));
  const workerColoCounts = mergeCounts(requests.map((request) => ({ [countKey(request.body?.workerColo)]: 1 })));
  const d1RegionCounts = mergeCounts(successful.map((request) => cleanCounts(request.body.d1?.regions || {})));
  const d1ColoCounts = mergeCounts(successful.map((request) => cleanCounts(request.body.d1?.colos || {})));
  const noteValues = uniqueValues(Object.keys(measurements.noteCounts || {}));
  const sqlDurations = successful
    .flatMap((request) => request.body.d1?.sqlDurations || [])
    .filter(isFiniteNumber);
  const measuredQueryCount = sumCounts(d1RegionCounts) || sumCounts(d1ColoCounts) || networkValues.length;
  const successCount = successful.length;

  return {
    id: `${run.id}|${db.key}|${db.coloKey}|${placement}`,
    runId: run.id,
    runLabel: run.label || run.id,
    runStartedAt: run.startedAt || null,
    runCompletedAt: run.completedAt || null,
    dbKey: db.key,
    dbLabel: db.d1Colo ? `${db.label} / ${db.d1Colo}` : db.label,
    d1ColoKey: db.coloKey,
    d1TargetLocation: db.targetLocation,
    d1ObservedRegion: db.observedRegion,
    d1ObservedColo: db.observedColo,
    placement,
    status: isPairReliable(successCount, minSuccessfulRequests) ? "ok" : "failed",
    note: noteValues.join(", ") || null,
    noteValues,
    noteCounts: measurements.noteCounts || {},
    measuredQueryCount,
    successCount,
    requestCount: requests.length,
    errorCount: measurements.failed.length,
    placementColo: countMapLabel(placementColoCounts),
    workerColo: countMapLabel(workerColoCounts),
    placementColoValues: Object.keys(placementColoCounts),
    workerColoValues: Object.keys(workerColoCounts),
    placementColoCounts,
    workerColoCounts,
    networkMs: numberOrNull(networkStats[DEFAULT_AGGREGATE_METRIC]),
    networkStats,
    d1Region: countMapLabel(d1RegionCounts),
    d1Colo: countMapLabel(d1ColoCounts),
    d1RegionValues: Object.keys(d1RegionCounts),
    d1ColoValues: Object.keys(d1ColoCounts),
    d1RegionCounts,
    d1ColoCounts,
    avgSqlMs: average(sqlDurations),
  };
}

function cleanCounts(counts) {
  const result = {};
  for (const [key, value] of Object.entries(counts || {})) {
    const count = Number(value) || 0;
    if (count <= 0) continue;
    const label = countKey(key);
    result[label] = (result[label] || 0) + count;
  }
  return result;
}

function sumCounts(counts) {
  return Object.values(counts || {}).reduce((sum, count) => sum + (Number(count) || 0), 0);
}

function countMapLabel(counts) {
  const entries = Object.entries(counts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return "-";
  if (entries.length === 1) return entries[0][0];
  return entries.map(([value, count]) => `${value}:${count}`).join(",");
}

function countKey(value) {
  if (value == null || value === "" || value === "undefined" || value === "null") return "-";
  return String(value);
}

function serializeBenchmarkConfig(benchmark) {
  if (!benchmark || typeof benchmark !== "object" || Array.isArray(benchmark)) return null;
  return {
    warmupRequests: benchmark.warmupRequests,
    measuredRequests: benchmark.measuredRequests,
    splitInRounds: benchmark.splitInRounds,
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
    ? MetricStats.metricStats(perQuery)
    : MetricStats.emptyMetricStats();

  const workerColos = mergeCounts(successful.map((r) => ({ [r.body.workerColo]: 1 })));
  const placementColos = mergeCounts(successful.map((r) => ({ [r.placementColo]: 1 })));
  const d1Regions = mergeCounts(successful.map((r) => (r.body.d1 && r.body.d1.regions) || {}));
  const d1Colos = mergeCounts(successful.map((r) => (r.body.d1 && r.body.d1.colos) || {}));

  return {
    dbKey: db.key,
    dbLabel: db.label,
    dbObservedRegion: db.observedRegion,
    d1ColoKey: db.coloKey,
    d1Colo: db.d1Colo || db.observedColo || null,
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
  for (const [coloKey, byPlacement] of Object.entries(raw.measured?.[dbKey] || {})) {
    if (coloKey && coloKey !== "unknown") counts[coloKey] = counts[coloKey] || 0;
    for (const requests of Object.values(byPlacement || {})) {
      for (const request of requests || []) {
        for (const [colo, count] of Object.entries(request?.body?.d1?.colos || {})) {
          if (!colo) continue;
          counts[colo] = (counts[colo] || 0) + (Number(count) || 0);
        }
      }
    }
  }
  for (const record of raw.databaseColocations || []) {
    if (record.key !== dbKey || !record.observedColo) continue;
    counts[record.observedColo] = counts[record.observedColo] || 1;
  }
  return Object.entries(counts)
    .filter(([colo, count]) => colo && count >= 0)
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
    rows: rows.length,
  };
}

function rawFilterFacets(rows) {
  return rawFacetCounts(rows);
}

function rawFacetCounts(rows) {
  const result = {};
  for (const key of ["run", "db", "placement", "placementColo", "workerColo", "d1Region", "d1Colo", "note"]) {
    result[key] = {};
  }
  for (const row of rows) {
    for (const key of Object.keys(result)) {
      for (const [value, count] of rawFilterEntries(row, key)) {
        result[key][value] = (result[key][value] || 0) + count;
      }
    }
  }
  return result;
}

function rawFilterEntries(row, key) {
  if (key === "run") return [[rawLabelValue(row.runId), row.measuredQueryCount || 0]];
  if (key === "db") return [[rawLabelValue(row.dbKey), row.measuredQueryCount || 0]];
  if (key === "placement") return [[rawLabelValue(row.placement), row.requestCount || 0]];
  if (key === "placementColo") return rawCountEntries(row.placementColoCounts, row.placementColoValues || [row.placementColo]);
  if (key === "workerColo") return rawCountEntries(row.workerColoCounts, row.workerColoValues || [row.workerColo]);
  if (key === "d1Region") return rawCountEntries(row.d1RegionCounts, row.d1RegionValues || [row.d1Region]);
  if (key === "d1Colo") return rawCountEntries(row.d1ColoCounts, row.d1ColoValues || [row.d1Colo]);
  if (key === "note") return rawCountEntries(row.noteCounts, row.noteValues?.length ? row.noteValues : [row.note]);

  return [];
}

function rawCountEntries(counts, fallbackValues) {
  const entries = Object.entries(counts || {}).filter(([, count]) => Number(count) > 0);
  if (entries.length) return entries.map(([value, count]) => [rawLabelValue(value), Number(count)]);
  return fallbackValues.map((value) => [rawLabelValue(value), 1]);
}

function rawLabelValue(value) {
  return value == null || value === "" ? "(none)" : String(value);
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
