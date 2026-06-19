#!/usr/bin/env node
// Build a self-contained, interactive static website from a benchmark
// raw.json file. Lets you compare Worker placements per D1 region, see the whole
// matrix at once, or filter down to a single D1 region to pick its best Worker.
//
// Usage:
//   node ./src/build-html-site.mjs [--input results/raw.json] [--output docs/index.html]
//
// Defaults: reads results/raw.json (falling back to results-partial/raw.json) and
// writes docs/index.html.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  const model = buildModel(raw);
  const [basemap, d1LocationCoordinates, providerRegionCoordinates] = await Promise.all([
    readJson("data/world-basemap.json"),
    readJson("data/d1-location-coordinates.json"),
    readJson("data/provider-region-coordinates.json"),
  ]);
  model.basemap = basemap;
  model.d1coords = d1LocationCoordinates;
  model.coords = providerRegionCoordinates;
  model.repoUrl = REPO_URL;

  const outputPath = resolvePath(args.output || DEFAULT_OUTPUT_PATH);
  const html = await renderHtml(model);
  await mkdir(dirname(outputPath), { recursive: true });
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
  console.log(`Build an interactive static website from benchmark raw data.

Usage:
  node ./src/build-html-site.mjs [--input <raw.json>] [--output <docs/index.html>]

Options:
  -i, --input   Path to raw.json (default: results/raw.json, else results-partial/raw.json)
  -o, --output  Path to write the HTML file (default: docs/index.html)
      --no-open Do not open the generated site in a browser
  -h, --help    Show this help`);
}

async function resolveInputPath(explicit) {
  if (explicit) return resolvePath(explicit);
  for (const candidate of ["results/raw.json", "results-partial/raw.json"]) {
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

async function readJson(path) {
  return JSON.parse(await readFile(resolve(rootDir, path), "utf8"));
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
      benchmark: serializeBenchmarkConfig(run.config && run.config.benchmark),
    },
    databases,
    placements,
    pairs,
    best: best ? { dbKey: best.dbKey, placement: best.placement } : null,
  };
}

function serializeBenchmarkConfig(benchmark) {
  if (!benchmark || typeof benchmark !== "object" || Array.isArray(benchmark)) return null;
  return {
    warmupRequests: benchmark.warmupRequests,
    measuredRequests: benchmark.measuredRequests,
    queriesPerRequest: benchmark.queriesPerRequest,
    requestTimeoutMs: benchmark.requestTimeoutMs,
  };
}

function summarizePair(db, placement, requests) {
  const ok = requests.filter((r) => r && r.ok && r.body);
  const totals = ok.map((r) => adjustedTotalMs(r.body)).filter(isFiniteNumber);
  const rawTotals = ok.map((r) => r.body.totalMs).filter(isFiniteNumber);
  const perQuery = ok.flatMap((r) => adjustedPerQueryMs(r.body)).filter(isFiniteNumber);
  const rawPerQuery = ok.flatMap((r) => r.body.perQueryMs || []).filter(isFiniteNumber);
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
    avgRaw: average(rawTotals),
    avgRawPerQuery: average(rawPerQuery),
    avgSqlMs: average(sqlDurations),
    workerColos,
    d1Regions,
    d1Colos,
  };
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

// --- stats helpers (kept in parity with run-benchmark.mjs) ------------------

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

const TEMPLATE_DIR = resolve(rootDir, "data/site-template");

async function renderHtml(model) {
  const [template, style, script] = await Promise.all([
    readFile(resolve(TEMPLATE_DIR, "index.html"), "utf8"),
    readFile(resolve(TEMPLATE_DIR, "style.css"), "utf8"),
    readFile(resolve(TEMPLATE_DIR, "script.js"), "utf8"),
  ]);
  const dataJson = JSON.stringify(model).replace(/</g, "\\u003c");

  return fillTemplate(template, {
    dataJson,
    repoUrl: escapeHtmlAttr(REPO_URL),
    script: "\n" + script.trimEnd() + "\n",
    style: "\n" + style.trimEnd() + "\n",
  });
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
