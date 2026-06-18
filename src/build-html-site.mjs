#!/usr/bin/env node
// Build a self-contained, interactive static website from a benchmark
// raw.json file. Lets you compare Worker placements per D1 region, see the whole
// matrix at once, or filter down to a single D1 region to pick its best Worker.
//
// Usage:
//   node ./src/build-html-site.mjs [--input results/raw.json] [--output site/index.html]
//
// Defaults: reads results/raw.json (falling back to results-partial/raw.json) and
// writes site/index.html.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Public repository URL shown in the report's "Source" link. Update before deploy.
const REPO_URL = "https://github.com/maxceem/cf-d1-to-worker-region-latency-analytics";
const DEFAULT_OUTPUT_PATH = "site/index.html";

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
  model.basemap = JSON.parse(
    await readFile(resolve(rootDir, "data/world-basemap.json"), "utf8")
  );
  model.d1coords = D1_COORDS;
  model.coords = PROVIDER_COORDS;
  model.repoUrl = REPO_URL;

  const outputPath = resolvePath(args.output || DEFAULT_OUTPUT_PATH);
  const html = renderHtml(model);
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
  node ./src/build-html-site.mjs [--input <raw.json>] [--output <site/index.html>]

Options:
  -i, --input   Path to raw.json (default: results/raw.json, else results-partial/raw.json)
  -o, --output  Path to write the HTML file (default: site/index.html)
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
      benchmark: (run.config && run.config.benchmark) || null,
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

// D1 location hints -> [lat, lon, city] (representative city per broad region).
const D1_COORDS = {
  wnam: [37.77, -122.42, "Western North America"],
  enam: [39.04, -77.49, "Eastern North America"],
  weur: [51.51, -0.13, "Western Europe"],
  eeur: [52.23, 21.01, "Eastern Europe"],
  apac: [1.35, 103.82, "Asia-Pacific"],
  oc: [-33.87, 151.21, "Oceania"],
};

// Worker placement "provider:region" -> [lat, lon, city] (host city per region).
const PROVIDER_COORDS = {
  aws: {
    "af-south-1": [-33.92, 18.42, "Cape Town"],
    "ap-east-1": [22.32, 114.17, "Hong Kong"],
    "ap-east-2": [25.03, 121.57, "Taipei"],
    "ap-northeast-1": [35.69, 139.69, "Tokyo"],
    "ap-northeast-2": [37.57, 126.98, "Seoul"],
    "ap-northeast-3": [34.69, 135.5, "Osaka"],
    "ap-south-1": [19.08, 72.88, "Mumbai"],
    "ap-south-2": [17.39, 78.49, "Hyderabad"],
    "ap-southeast-1": [1.35, 103.82, "Singapore"],
    "ap-southeast-2": [-33.87, 151.21, "Sydney"],
    "ap-southeast-3": [-6.21, 106.85, "Jakarta"],
    "ap-southeast-4": [-37.81, 144.96, "Melbourne"],
    "ap-southeast-5": [3.14, 101.69, "Kuala Lumpur"],
    "ap-southeast-6": [-36.85, 174.76, "Auckland"],
    "ap-southeast-7": [13.76, 100.5, "Bangkok"],
    "ca-central-1": [45.5, -73.57, "Montreal"],
    "ca-west-1": [51.04, -114.07, "Calgary"],
    "eu-central-1": [50.11, 8.68, "Frankfurt"],
    "eu-central-2": [47.37, 8.54, "Zurich"],
    "eu-north-1": [59.33, 18.07, "Stockholm"],
    "eu-south-1": [45.46, 9.19, "Milan"],
    "eu-south-2": [41.65, -0.89, "Aragon (Zaragoza)"],
    "eu-west-1": [53.35, -6.26, "Dublin"],
    "eu-west-2": [51.51, -0.13, "London"],
    "eu-west-3": [48.86, 2.35, "Paris"],
    "il-central-1": [32.09, 34.78, "Tel Aviv"],
    "me-central-1": [25.2, 55.27, "UAE (Dubai)"],
    "me-south-1": [26.07, 50.55, "Bahrain"],
    "mx-central-1": [20.59, -100.39, "Queretaro"],
    "sa-east-1": [-23.55, -46.63, "Sao Paulo"],
    "us-east-1": [38.95, -77.45, "N. Virginia"],
    "us-east-2": [40.0, -83.0, "Ohio"],
    "us-west-1": [37.35, -121.96, "N. California"],
    "us-west-2": [45.87, -119.69, "Oregon"],
  },
  gcp: {
    "africa-south1": [-26.2, 28.05, "Johannesburg"],
    "asia-east1": [24.05, 120.52, "Changhua, Taiwan"],
    "asia-east2": [22.32, 114.17, "Hong Kong"],
    "asia-northeast1": [35.69, 139.69, "Tokyo"],
    "asia-northeast2": [34.69, 135.5, "Osaka"],
    "asia-northeast3": [37.57, 126.98, "Seoul"],
    "asia-south1": [19.08, 72.88, "Mumbai"],
    "asia-south2": [28.61, 77.21, "Delhi"],
    "asia-southeast1": [1.35, 103.82, "Singapore"],
    "asia-southeast2": [-6.21, 106.85, "Jakarta"],
    "australia-southeast1": [-33.87, 151.21, "Sydney"],
    "australia-southeast2": [-37.81, 144.96, "Melbourne"],
    "europe-central2": [52.23, 21.01, "Warsaw"],
    "europe-north1": [60.57, 27.19, "Hamina, Finland"],
    "europe-north2": [59.33, 18.07, "Stockholm"],
    "europe-southwest1": [40.42, -3.7, "Madrid"],
    "europe-west1": [50.47, 3.82, "St. Ghislain, Belgium"],
    "europe-west10": [52.52, 13.4, "Berlin"],
    "europe-west12": [45.07, 7.69, "Turin"],
    "europe-west2": [51.51, -0.13, "London"],
    "europe-west3": [50.11, 8.68, "Frankfurt"],
    "europe-west4": [53.43, 6.83, "Eemshaven, Netherlands"],
    "europe-west6": [47.37, 8.54, "Zurich"],
    "europe-west8": [45.46, 9.19, "Milan"],
    "europe-west9": [48.86, 2.35, "Paris"],
    "me-central1": [25.29, 51.53, "Doha"],
    "me-central2": [26.43, 50.1, "Dammam, Saudi Arabia"],
    "me-west1": [32.09, 34.78, "Tel Aviv"],
    "northamerica-northeast1": [45.5, -73.57, "Montreal"],
    "northamerica-northeast2": [43.65, -79.38, "Toronto"],
    "northamerica-south1": [20.59, -100.39, "Queretaro"],
    "southamerica-east1": [-23.55, -46.63, "Sao Paulo"],
    "southamerica-west1": [-33.45, -70.67, "Santiago"],
    "us-central1": [41.26, -95.86, "Council Bluffs, Iowa"],
    "us-east1": [33.2, -79.99, "Moncks Corner, S. Carolina"],
    "us-east4": [39.02, -77.46, "Ashburn, Virginia"],
    "us-east5": [39.96, -83.0, "Columbus, Ohio"],
    "us-south1": [32.78, -96.8, "Dallas"],
    "us-west1": [45.6, -121.18, "The Dalles, Oregon"],
    "us-west2": [34.05, -118.24, "Los Angeles"],
    "us-west3": [40.76, -111.89, "Salt Lake City"],
    "us-west4": [36.17, -115.14, "Las Vegas"],
  },
  azure: {
    australiacentral: [-35.28, 149.13, "Canberra"],
    australiacentral2: [-35.28, 149.13, "Canberra"],
    australiaeast: [-33.87, 151.21, "Sydney"],
    australiasoutheast: [-37.81, 144.96, "Melbourne"],
    austriaeast: [48.21, 16.37, "Vienna"],
    belgiumcentral: [50.85, 4.35, "Brussels"],
    brazilsouth: [-23.55, -46.63, "Sao Paulo"],
    brazilsoutheast: [-22.91, -43.17, "Rio de Janeiro"],
    canadacentral: [43.65, -79.38, "Toronto"],
    canadaeast: [46.81, -71.21, "Quebec City"],
    centralindia: [18.52, 73.86, "Pune"],
    centralus: [41.59, -93.62, "Iowa"],
    chilecentral: [-33.45, -70.67, "Santiago"],
    eastasia: [22.32, 114.17, "Hong Kong"],
    eastus: [37.37, -79.82, "Virginia"],
    eastus2: [36.67, -78.39, "Virginia"],
    francecentral: [48.86, 2.35, "Paris"],
    francesouth: [43.3, 5.37, "Marseille"],
    germanynorth: [52.52, 13.4, "Berlin"],
    germanywestcentral: [50.11, 8.68, "Frankfurt"],
    indonesiacentral: [-6.21, 106.85, "Jakarta"],
    israelcentral: [32.09, 34.78, "Israel (Tel Aviv)"],
    italynorth: [45.46, 9.19, "Milan"],
    japaneast: [35.69, 139.69, "Tokyo"],
    japanwest: [34.69, 135.5, "Osaka"],
    koreacentral: [37.57, 126.98, "Seoul"],
    koreasouth: [35.18, 129.08, "Busan"],
    malaysiawest: [3.14, 101.69, "Kuala Lumpur"],
    mexicocentral: [20.59, -100.39, "Queretaro"],
    newzealandnorth: [-36.85, 174.76, "Auckland"],
    northcentralus: [41.88, -87.63, "Illinois (Chicago)"],
    northeurope: [53.35, -6.26, "Ireland (Dublin)"],
    norwayeast: [59.91, 10.75, "Oslo"],
    norwaywest: [58.97, 5.73, "Stavanger"],
    polandcentral: [52.23, 21.01, "Warsaw"],
    qatarcentral: [25.29, 51.53, "Doha"],
    southafricanorth: [-26.2, 28.05, "Johannesburg"],
    southafricawest: [-33.92, 18.42, "Cape Town"],
    southcentralus: [29.42, -98.49, "Texas (San Antonio)"],
    southeastasia: [1.35, 103.82, "Singapore"],
    southindia: [13.08, 80.27, "Chennai"],
    spaincentral: [40.42, -3.7, "Madrid"],
    swedencentral: [60.67, 17.14, "Gavle"],
    switzerlandnorth: [47.37, 8.54, "Zurich"],
    switzerlandwest: [46.2, 6.14, "Geneva"],
    uaecentral: [24.45, 54.38, "Abu Dhabi"],
    uaenorth: [25.2, 55.27, "Dubai"],
    uksouth: [51.51, -0.13, "London"],
    ukwest: [51.48, -3.18, "Cardiff"],
    westcentralus: [41.14, -104.82, "Wyoming (Cheyenne)"],
    westeurope: [52.37, 4.9, "Netherlands (Amsterdam)"],
    westindia: [19.08, 72.88, "Mumbai"],
    westus: [37.78, -122.42, "California (San Francisco)"],
    westus2: [47.23, -119.85, "Washington (Quincy)"],
    westus3: [33.45, -112.07, "Phoenix"],
  },
};

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
<title>Cloudflare D1-to-Worker Latency Analytics</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800&family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..600&family=IBM+Plex+Mono:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />
<style>${STYLE}</style>
</head>
<body>
<div class="topbar">
<button id="themeToggle" class="theme-toggle" type="button" aria-label="Toggle light/dark theme">☾</button>
<a class="gh-link" href="${REPO_URL}" target="_blank" rel="noopener" aria-label="View source on GitHub"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor"><path d="M12 .5C5.37.5 0 5.78 0 12.292c0 5.211 3.438 9.63 8.205 11.188.6.111.82-.254.82-.567 0-.28-.01-1.022-.015-2.005-3.338.711-4.042-1.582-4.042-1.582-.546-1.361-1.335-1.725-1.335-1.725-1.087-.731.084-.716.084-.716 1.205.082 1.838 1.215 1.838 1.215 1.07 1.803 2.809 1.282 3.495.981.108-.763.417-1.282.76-1.577-2.665-.295-5.466-1.309-5.466-5.827 0-1.287.465-2.339 1.235-3.164-.135-.298-.54-1.497.105-3.121 0 0 1.005-.316 3.3 1.209.96-.262 1.98-.392 3-.397 1.02.005 2.04.135 3 .397 2.295-1.525 3.3-1.209 3.3-1.209.645 1.624.24 2.823.12 3.121.765.825 1.23 1.877 1.23 3.164 0 4.53-2.805 5.527-5.475 5.817.42.354.81 1.077.81 2.182 0 1.578-.015 2.846-.015 3.229 0 .309.21.678.825.561C20.565 21.917 24 17.495 24 12.292 24 5.78 18.63.5 12 .5z"/></svg>Source</a>
</div>
<div id="maptip" class="maptip" hidden><div class="maptip-ms"></div><div class="maptip-loc"></div></div>
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
  --accent-2: #2970F6;
  --card-shadow: 0 14px 32px rgba(150,175,215,.13), 0 4px 12px rgba(150,175,215,.09), inset 0 1px 0 rgba(255,255,255,.06);
  --toggle-shadow: 0 6px 18px rgba(150,175,215,.16), inset 0 1px 0 rgba(255,255,255,.07);
  --map-ocean: #0e1218; --map-land: #2c3743;
  --good: #2ea043;
  --bad: #e5534b;
  --shadow: 0 1px 3px rgba(0,0,0,.4);
}
* { box-sizing: border-box; }
html { overflow-x: hidden; }
body {
  margin: 0;
  font: 14px/1.5 "Bricolage Grotesque", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: radial-gradient(140% 120% at 0% 0%, #161b22 0%, #0e1116 58%) fixed, #0e1116;
  color: var(--text);
}
/* light theme */
:root[data-theme="light"] {
  --panel: #ffffff; --panel-2: #eef2f7; --border: #dde3ea;
  --text: #1b2533; --muted: #5d6b7c; --bg: #eef2f7;
  --card-shadow: 0 12px 28px rgba(0,0,0,.45);
  --toggle-shadow: 0 4px 14px rgba(0,0,0,.25);
  --map-ocean: #dde6ef; --map-land: #b3c1d1;
}
[data-theme="light"] body {
  background: #ffffff;
}
[data-theme="light"] .hx12.s-slate {
  --bd: #d9e0e8; --ac: #2970F6; --tabbd: #cfd7e1; --mut: #6b7787;
  --cardbg: #ffffff; --ocean: #dde6ef; --land: #b3c1d1; --txt: #1b2533; --foot: #5a6675;
  --fademid: rgba(255,255,255,.42); --fadeend: rgba(255,255,255,.82);
}
[data-theme="light"] .v12name, [data-theme="light"] .v12val, [data-theme="light"] .v12loc { text-shadow: 0 1px 6px rgba(255,255,255,.7); }

.topbar {
  position: absolute; top: 18px; z-index: 50;
  left: max(20px, calc((100vw - 1180px) / 2 + 20px));
  right: max(20px, calc((100vw - 1180px) / 2 + 20px));
  display: flex; align-items: center; justify-content: space-between;
}
.gh-link {
  display: inline-flex; align-items: center; gap: 7px; padding: 6px 12px;
  border-radius: 8px; border: 1px solid var(--border); background: var(--panel-2);
  color: var(--text); font-size: 13px; font-weight: 600; text-decoration: none; line-height: 1;
}
.gh-link svg { display: block; }
.gh-link:hover { border-color: var(--accent-2); text-decoration: none; }
.theme-toggle {
  width: 32px; height: 32px; border-radius: 8px; line-height: 1; padding: 0;
  background: transparent; border: none; color: var(--muted);
  font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.theme-toggle:hover { color: var(--text); }

.wrap { max-width: 1180px; margin: 0 auto; padding: 80px 20px 96px; }
h1 { font-size: 58px; font-weight: 800; margin: 0 0 40px; letter-spacing: -1.2px; line-height: 1.04; }
h2 { font-size: 29px; font-weight: 700; margin: 52px 0 20px; letter-spacing: -.5px; }
.sub { color: var(--muted); font-size: 14px; line-height: 1.55; margin: 0 0 12px; max-width: 760px; }
h2.why { margin-top: 0; }
.intro { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 44px; align-items: center; margin-bottom: 20px; }
.intro-text .sub { margin-bottom: 0; }
@media (max-width: 860px) { .intro { grid-template-columns: 1fr; gap: 20px; } }
.idea-fig { margin: 0; background: var(--panel-2); border-radius: 16px; padding: 22px 22px; }
.idea-svg { width: 100%; max-width: 620px; height: auto; display: block; margin: 0 auto; }
.idea-svg .pin { fill: var(--accent-2); }
.idea-svg .dot { fill: var(--accent-2); }
.idea-svg .ln { fill: none; stroke: var(--accent-2); stroke-width: 3; stroke-linejoin: round; }
.idea-svg .wkmark { fill: var(--accent); }
.idea-svg .arw { stroke: var(--muted); stroke-width: 2; }
.idea-svg .arw-head { fill: var(--muted); }
.idea-svg text { fill: var(--text); }
.idea-svg .loc { font-size: 15px; }
.idea-svg .lbl { font-size: 16px; font-weight: 700; }
.idea-cap { color: var(--muted); font-size: 14px; line-height: 1.55; margin: 0; max-width: 760px; }
.idea-link { font-size: 14px; margin: 12px 0 0; }
.idea-cap a, .idea-link a { color: var(--accent-2); }
a { color: var(--accent-2); text-decoration: none; }
a:hover { text-decoration: underline; }

.meta { display: flex; flex-wrap: wrap; gap: 10px 22px; color: var(--muted); font-size: 12.5px; margin-bottom: 18px; }
.meta b { color: var(--text); font-weight: 600; }
.details { margin-top: 64px; padding-top: 0; }
.details .sub { margin: 0 0 30px; max-width: 720px; }
.detgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 28px 34px; }
.det-k { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 7px; }
.det-v { font-size: 19px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.det.wide { grid-column: span 2; }
.det-v.mono { font-family: "IBM Plex Mono", monospace; font-size: 13px; font-weight: 500; word-break: break-word; }
@media (max-width: 600px) { .det.wide { grid-column: span 1; } }
.pagefoot { margin-top: 52px; padding-top: 24px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; display: flex; justify-content: space-between; align-items: flex-start; gap: 8px 24px; flex-wrap: wrap; }
.foot-left { display: flex; flex-direction: column; gap: 4px; }
.pagefoot a { color: var(--accent-2); }

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

.tabs {
  display: flex; flex-direction: column; gap: 10px;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 14px 16px; margin-bottom: 22px;
}
.tabrow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.tablabel { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); min-width: 72px; }
.tabset { display: flex; flex-wrap: wrap; gap: 6px; }
.tab {
  background: var(--panel-2); color: var(--muted);
  border: 1px solid var(--border); border-radius: 7px;
  padding: 6px 12px; font-size: 13px; cursor: pointer;
  font-family: inherit; line-height: 1.2;
}
.tab:hover { color: var(--text); border-color: var(--accent-2); }
.tab.active { background: var(--accent-2); color: #fff; border-color: var(--accent-2); font-weight: 600; }

/* ===== "Best worker regions" — 5 concept explorations ===== */
.hx-lab { display: flex; flex-direction: column; gap: 30px; margin: 8px 0 56px; }
.hx-cap { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin: 0 0 4px; }
.hx { border-radius: 16px; position: relative; overflow: hidden; }

/* -- 01 Leaderboard: editorial, warm paper, ranked typographic list -- */
.hx1 { background: #f3efe6; color: #1a1714; padding: 30px 34px 22px; font-family: "Archivo", sans-serif; box-shadow: 0 24px 60px rgba(0,0,0,.5); }
.hx1head { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: 12px; border-bottom: 2px solid #1a1714; padding-bottom: 16px; }
.hx1kick { font-size: 11px; letter-spacing: .3em; text-transform: uppercase; color: #9b9080; font-weight: 700; }
.hx1title { font-family: "Fraunces", Georgia, serif; font-weight: 600; font-size: 32px; line-height: 1; margin-top: 8px; letter-spacing: -.01em; }
.hx1tabs { grid-row: 1 / span 2; align-self: center; display: flex; gap: 2px; }
.v1tab { font-family: "Archivo", sans-serif; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; background: none; border: none; color: #b9af9d; cursor: pointer; padding: 6px 7px; border-bottom: 2px solid transparent; }
.v1tab.on { color: #1a1714; border-bottom-color: #c8541f; }
.v1row { display: grid; grid-template-columns: 46px 1fr auto auto; align-items: baseline; column-gap: 16px; padding: 14px 0; border-bottom: 1px solid #ddd5c6; }
.v1row:last-child { border-bottom: none; }
.v1rank { font-family: "Fraunces", serif; font-size: 22px; font-weight: 500; color: #bcb2a0; font-variant-numeric: tabular-nums; }
.v1region { font-family: "Fraunces", serif; font-size: 23px; font-weight: 500; }
.v1loc { font-size: 11px; letter-spacing: .05em; text-transform: uppercase; color: #9b9080; justify-self: end; }
.v1val { font-family: "Fraunces", serif; font-size: 27px; font-weight: 600; font-variant-numeric: tabular-nums; min-width: 92px; text-align: right; }
.v1val i { font-style: normal; font-size: 12px; color: #9b9080; margin-left: 2px; }
.v1-lead .v1rank, .v1-lead .v1val { color: #c8541f; }
.v1-lead .v1region { text-decoration: underline; text-decoration-color: #c8541f; text-underline-offset: 5px; text-decoration-thickness: 2px; }

/* -- 02 Scale: analytical mono, single shared latency axis -- */
.hx2 { background: #0a0e13; color: #cdd6e0; padding: 26px 30px 30px; font-family: "IBM Plex Mono", monospace; border: 1px solid #1d2630; }
.hx2head { display: flex; align-items: baseline; gap: 14px; margin-bottom: 8px; }
.hx2kick { font-size: 12px; letter-spacing: .2em; color: #5cc8ff; text-transform: uppercase; }
.hx2sub { font-size: 11px; color: #5d6b7a; letter-spacing: .03em; }
.hx2tabs { margin-left: auto; display: flex; gap: 3px; }
.v2tab { font-family: "IBM Plex Mono", monospace; font-size: 11px; background: #121a22; border: 1px solid #1f2a35; color: #6b7a8a; padding: 4px 8px; cursor: pointer; border-radius: 3px; }
.v2tab.on { color: #0a0e13; background: #5cc8ff; border-color: #5cc8ff; }
.v2plot { position: relative; height: 188px; }
.v2track { position: absolute; left: 70px; right: 70px; top: 94px; height: 2px; border-radius: 2px; background: linear-gradient(90deg,#1f9c4d,#d8c531,#d9534f); }
.v2mark { position: absolute; top: 0; }
.v2dot { position: absolute; top: -5px; left: -6px; width: 10px; height: 10px; border-radius: 50%; background: #e6edf3; box-shadow: 0 0 0 3px #0a0e13; }
.v2stem { position: absolute; left: -0.5px; width: 1px; background: #2a3744; }
.v2mark.up .v2stem { bottom: 5px; height: 32px; }
.v2mark.down .v2stem { top: 5px; height: 32px; }
.v2lab { position: absolute; left: 50%; transform: translateX(-50%); text-align: center; white-space: nowrap; }
.v2mark.up .v2lab { bottom: 40px; }
.v2mark.down .v2lab { top: 40px; }
.v2reg { display: block; font-size: 12px; color: #e6edf3; letter-spacing: .05em; }
.v2v { display: block; font-size: 16px; font-weight: 600; color: #5cc8ff; }
.v2v i { font-style: normal; font-size: 9px; color: #5d6b7a; margin-left: 1px; }
.v2loc { display: block; font-size: 9.5px; color: #5d6b7a; }
.v2end { position: absolute; top: 104px; font-size: 10px; color: #5d6b7a; }
.v2lo { left: 70px; transform: translateX(-50%); }
.v2hi { right: 70px; transform: translateX(50%); }

/* -- 03 Spotlight: luxury dark + gold, one hero stat + supporting list -- */
.hx3 { background: radial-gradient(130% 150% at 0% 0%, #1c1611 0%, #0c0a09 58%); color: #f0e9dd; padding: 30px 34px; font-family: "Bricolage Grotesque", sans-serif; border: 1px solid #2a2118; }
.hx3tabs { display: flex; justify-content: flex-end; gap: 4px; margin-bottom: 12px; }
.v3tab { font-family: "Bricolage Grotesque", sans-serif; font-size: 11px; font-weight: 600; background: none; border: 1px solid #3a2f22; color: #8a7860; padding: 4px 10px; border-radius: 999px; cursor: pointer; }
.v3tab.on { color: #0c0a09; background: #e9b873; border-color: #e9b873; }
.v3grid { display: grid; grid-template-columns: 1.05fr 1fr; gap: 34px; align-items: center; }
.v3badge { font-size: 11px; letter-spacing: .24em; text-transform: uppercase; color: #e9b873; margin-bottom: 12px; }
.v3num { font-size: 96px; font-weight: 700; line-height: .86; letter-spacing: -.04em; font-variant-numeric: tabular-nums; }
.v3num span { font-size: 26px; font-weight: 500; color: #8a7860; margin-left: 8px; }
.v3route { margin-top: 16px; font-size: 16px; color: #c9bdac; }
.v3route b { font-weight: 700; color: #f0e9dd; }
.v3arr { color: #e9b873; margin: 0 10px; }
.v3rest { display: flex; flex-direction: column; }
.v3row { display: grid; grid-template-columns: auto 1fr auto; column-gap: 12px; align-items: baseline; padding: 12px 0; border-top: 1px solid #241c14; }
.v3reg { font-weight: 600; font-size: 15px; }
.v3loc { font-size: 11px; color: #8a7860; justify-self: start; }
.v3v { font-variant-numeric: tabular-nums; font-size: 19px; font-weight: 600; }
.v3v i { font-style: normal; font-size: 10px; color: #8a7860; margin-left: 1px; }

/* -- 04 Magnitude: industrial bar chart, sharp edges, single accent -- */
.hx4 { background: #14181d; color: #dfe6ed; padding: 24px 28px; font-family: "Archivo", sans-serif; border-left: 3px solid #ff5c35; }
.hx4head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.hx4kick { font-size: 11px; letter-spacing: .2em; text-transform: uppercase; color: #ff5c35; font-weight: 700; }
.hx4tabs { display: flex; }
.v4tab { font-family: "Archivo", sans-serif; font-size: 11px; font-weight: 700; background: #1d242b; border: 1px solid #29333d; border-right: none; color: #7d8a98; padding: 5px 10px; cursor: pointer; }
.v4tab:last-child { border-right: 1px solid #29333d; }
.v4tab.on { background: #ff5c35; color: #14181d; border-color: #ff5c35; }
.v4row { display: grid; grid-template-columns: 84px 1fr 80px; align-items: center; column-gap: 14px; padding: 7px 0; }
.v4reg { font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #aeb9c5; }
.v4barwrap { position: relative; height: 28px; display: flex; align-items: center; }
.v4bar { height: 28px; background: #33404d; min-width: 3px; transition: width .35s ease; }
.v4best .v4bar { background: #ff5c35; }
.v4loc { position: absolute; left: 10px; font-size: 11px; color: #dfe6ed; font-family: "IBM Plex Mono", monospace; white-space: nowrap; pointer-events: none; }
.v4best .v4loc { color: #14181d; }
.v4val { text-align: right; font-family: "IBM Plex Mono", monospace; font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.v4val i { font-style: normal; font-size: 10px; color: #7d8a98; margin-left: 1px; }

/* -- 05 Departures: amber flip-board, D1 to Worker as routes -- */
.hx5 { background: #0b0c0a; padding: 22px; font-family: "Space Mono", monospace; }
.v5board { background: #0e100c; border: 1px solid #232818; border-radius: 8px; padding: 16px 20px; box-shadow: inset 0 0 60px rgba(255,176,0,.04); }
.v5top { display: flex; align-items: center; gap: 10px; padding-bottom: 12px; border-bottom: 1px dashed #2c3322; }
.v5dot { width: 8px; height: 8px; border-radius: 50%; background: #ffb000; box-shadow: 0 0 10px #ffb000; }
.v5title { color: #ffb000; letter-spacing: .14em; font-size: 13px; font-weight: 700; text-transform: uppercase; }
.v5tabs { margin-left: auto; display: flex; gap: 3px; }
.v5tab { font-family: "Space Mono", monospace; font-size: 10px; background: #15180f; border: 1px solid #2c3322; color: #7d7a4a; padding: 3px 7px; cursor: pointer; }
.v5tab.on { background: #ffb000; color: #0b0c0a; border-color: #ffb000; }
.v5cols, .v5row { display: grid; grid-template-columns: 1fr 30px 1.5fr auto; column-gap: 12px; align-items: center; }
.v5cols { font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase; color: #6b6a3f; padding: 10px 0 4px; }
.v5row { padding: 11px 0; border-top: 1px solid #1b1e12; color: #d9e0b8; }
.v5reg { color: #ffb000; font-weight: 700; letter-spacing: .08em; font-size: 15px; }
.v5plane { color: #7d7a4a; text-align: center; }
.v5dest { color: #cfd6a8; font-size: 13px; }
.v5time { font-size: 19px; font-weight: 700; color: #ffb000; font-variant-numeric: tabular-nums; text-align: right; }
.v5time i { font-style: normal; font-size: 10px; color: #7d7a4a; margin-left: 1px; }

/* -- 06 Signal traces: PCB / circuit-board pairings -- */
.hx6 { background:
    linear-gradient(#0a1714 0 0) padding-box,
    repeating-linear-gradient(0deg, #0c1c18 0 23px, #0a1714 23px 24px),
    repeating-linear-gradient(90deg, #0c1c18 0 23px, #0a1714 23px 24px);
  background-color: #0a1714; color: #8fe6c4; padding: 26px 30px; font-family: "IBM Plex Mono", monospace; border: 1px solid #14302a; }
.hx6head { display: flex; align-items: baseline; gap: 14px; margin-bottom: 18px; }
.hx6kick { font-size: 12px; letter-spacing: .2em; text-transform: uppercase; color: #2fd6a0; }
.hx6sub { font-size: 11px; color: #4a7a6a; }
.hx6tabs { margin-left: auto; display: flex; gap: 3px; }
.v6tab { font-family: "IBM Plex Mono", monospace; font-size: 11px; background: #0c2019; border: 1px solid #1c3a32; color: #5a9a86; padding: 4px 8px; cursor: pointer; border-radius: 3px; }
.v6tab.on { background: #2fd6a0; color: #06120f; border-color: #2fd6a0; }
.v6board { display: flex; flex-direction: column; gap: 14px; }
.v6trace { display: grid; grid-template-columns: 150px 1fr 200px; align-items: center; gap: 0; }
.v6pad { font-size: 12px; letter-spacing: .04em; padding: 9px 12px; border: 1px solid #1f4a3e; border-radius: 5px; background: #0c2019; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.v6src { color: #cdeede; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; box-shadow: inset 0 0 0 2px #0a1714, 0 0 0 1px #2fd6a0; }
.v6dst { color: #7fbfa8; text-align: right; }
.v6wire { position: relative; height: 2px; background: var(--c); margin: 0 -1px; opacity: .55; display: flex; justify-content: center; align-items: center; }
.v6wire::before, .v6wire::after { content: ""; position: absolute; top: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
.v6wire::before { left: -4px; } .v6wire::after { right: -4px; }
.v6chip { background: #0a1714; border: 1px solid; border-radius: 999px; padding: 4px 11px; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; position: relative; z-index: 1; }
.v6chip i { font-style: normal; font-size: 9px; opacity: .7; margin-left: 1px; }

/* -- 07 Dials: radial speedometer gauges -- */
.hx7 { background: #10151b; color: #dbe3ec; padding: 26px 28px; font-family: "Archivo", sans-serif; border: 1px solid #222c37; }
.hx7head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 22px; }
.hx7kick { font-size: 11px; letter-spacing: .22em; text-transform: uppercase; color: #6fa8dc; font-weight: 700; }
.hx7tabs { display: flex; gap: 3px; }
.v7tab { font-family: "Archivo", sans-serif; font-size: 11px; font-weight: 700; background: #1a212a; border: 1px solid #2a3540; color: #7d8a98; padding: 5px 9px; cursor: pointer; border-radius: 5px; }
.v7tab.on { background: #6fa8dc; color: #10151b; border-color: #6fa8dc; }
.v7grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 16px; }
.v7cell { text-align: center; }
.v7gauge { position: relative; width: 100%; aspect-ratio: 1; max-width: 120px; margin: 0 auto; border-radius: 50%;
  background: conic-gradient(var(--c) calc(var(--p) * 3.6deg), #1c2530 0); }
.v7inner { position: absolute; inset: 11px; border-radius: 50%; background: #10151b; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.v7v { font-size: 26px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
.v7u { font-size: 10px; color: #6c7a89; margin-top: 1px; }
.v7reg { margin-top: 12px; font-size: 12px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: #cdd6e0; }
.v7loc { font-size: 10.5px; color: #6c7a89; margin-top: 3px; word-break: break-word; }

/* -- 08 Manifesto: bold editorial recommendation statements -- */
.hx8 { background: #faf7f0; color: #14110d; padding: 32px 36px; font-family: "Bricolage Grotesque", sans-serif; box-shadow: 0 24px 60px rgba(0,0,0,.5); }
.hx8head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.hx8kick { font-size: 11px; letter-spacing: .26em; text-transform: uppercase; color: #b1452a; font-weight: 700; }
.hx8tabs { display: flex; gap: 2px; }
.v8tab { font-family: "Bricolage Grotesque", sans-serif; font-size: 11px; font-weight: 700; background: none; border: none; color: #bdb3a2; padding: 6px 7px; cursor: pointer; border-bottom: 2px solid transparent; }
.v8tab.on { color: #b1452a; border-bottom-color: #b1452a; }
.v8line { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; padding: 16px 0; border-bottom: 1px solid #e7e0d2; }
.v8line:last-child { border-bottom: none; }
.v8reg { font-size: 34px; font-weight: 800; letter-spacing: -.02em; line-height: 1; }
.v8mid, .v8at { font-size: 14px; color: #9c917e; font-weight: 500; }
.v8loc { font-family: "IBM Plex Mono", monospace; font-size: 15px; background: #14110d; color: #faf7f0; padding: 3px 9px; border-radius: 5px; }
.v8v { margin-left: auto; font-size: 34px; font-weight: 800; letter-spacing: -.02em; color: #b1452a; font-variant-numeric: tabular-nums; }
.v8v i { font-style: normal; font-size: 14px; color: #9c917e; margin-left: 2px; }

/* -- 09 Routing manifest: terminal printout -- */
.hx9 { padding: 0; background: none; }
.v9term { background: #0d1117; border: 1px solid #222b35; border-radius: 12px; overflow: hidden; font-family: "IBM Plex Mono", monospace; box-shadow: 0 18px 44px rgba(0,0,0,.45); }
.v9bar { display: flex; align-items: center; gap: 7px; padding: 11px 14px; background: #161b22; border-bottom: 1px solid #222b35; }
.v9b { width: 11px; height: 11px; border-radius: 50%; }
.v9b.r { background: #ff5f56; } .v9b.y { background: #ffbd2e; } .v9b.g { background: #27c93f; }
.v9file { font-size: 11.5px; color: #7d8a98; margin-left: 6px; }
.v9tabs { margin-left: auto; display: flex; gap: 3px; }
.v9tab { font-family: "IBM Plex Mono", monospace; font-size: 10.5px; background: #0d1117; border: 1px solid #2a3540; color: #6e7d8c; padding: 3px 7px; cursor: pointer; border-radius: 4px; }
.v9tab.on { background: #27c93f; color: #0d1117; border-color: #27c93f; }
.v9body { padding: 16px 18px 20px; font-size: 13.5px; line-height: 1.5; }
.v9cmd { color: #c9d4e0; }
.v9prompt { color: #27c93f; margin-right: 8px; }
.v9comment { color: #5d6b7a; margin: 4px 0 12px; }
.v9line { display: grid; grid-template-columns: 90px 18px 1fr auto; gap: 10px; align-items: baseline; padding: 4px 0; }
.v9reg { color: #ffbd2e; font-weight: 600; letter-spacing: .04em; }
.v9arr { color: #5d6b7a; }
.v9loc { color: #6fd0ff; }
.v9v { color: #e6edf3; font-weight: 600; font-variant-numeric: tabular-nums; }

/* -- 10 Postage: collectible latency stamps -- */
.hx10 { background: radial-gradient(140% 120% at 80% 0%, #241c16 0%, #120f0c 60%); padding: 28px 30px; border: 1px solid #2a2118; }
.hx10head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.hx10kick { font-size: 11px; letter-spacing: .24em; text-transform: uppercase; color: #d9b86a; font-weight: 700; font-family: "Bricolage Grotesque", sans-serif; }
.hx10tabs { display: flex; gap: 3px; }
.v10tab { font-family: "Space Mono", monospace; font-size: 10.5px; background: #1c160f; border: 1px solid #3a2f1d; color: #9a855a; padding: 4px 8px; cursor: pointer; border-radius: 4px; }
.v10tab.on { background: #d9b86a; color: #120f0c; border-color: #d9b86a; }
.v10grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; }
.v10stamp { transition: transform .2s ease; }
.v10stamp:hover { transform: rotate(0deg) scale(1.03) !important; }
.v10perf { background: #f4ecd8; border-radius: 3px; padding: 7px; box-shadow: 0 10px 26px rgba(0,0,0,.55); }
.v10inner { position: relative; border: 2px dashed #c2a868; border-radius: 2px; padding: 16px 16px 14px; overflow: hidden; }
.v10inner::after { content: ""; position: absolute; right: -16px; top: -16px; width: 64px; height: 64px; border: 1.5px solid rgba(154,123,58,.35); border-radius: 50%; }
.v10top { display: flex; align-items: center; justify-content: space-between; }
.v10post { font-family: "Space Mono", monospace; font-size: 8px; letter-spacing: .18em; color: #a8853a; }
.v10reg { font-family: "Bricolage Grotesque", sans-serif; font-size: 14px; font-weight: 800; letter-spacing: .04em; color: #1a140c; }
.v10val { font-family: "Bricolage Grotesque", sans-serif; font-size: 42px; font-weight: 800; line-height: 1; margin: 12px 0 4px; font-variant-numeric: tabular-nums; }
.v10val span { font-size: 14px; font-weight: 600; color: #9a7b3a; margin-left: 2px; }
.v10loc { font-family: "Space Mono", monospace; font-size: 10.5px; color: #6a5b3a; word-break: break-word; }

/* -- 11 Cartogram: a cropped world map per region fading into latency -- */
.hx11 { background: #0d1117; padding: 24px 26px; border: 1px solid #1d2630; font-family: "Bricolage Grotesque", sans-serif; }
.hx11head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.hx11kick { font-size: 11px; letter-spacing: .22em; text-transform: uppercase; color: #6fd0ff; font-weight: 700; }
.hx11tabs { display: flex; gap: 3px; }
.v11tab { font-family: "Bricolage Grotesque", sans-serif; font-size: 11px; font-weight: 700; background: #161d27; border: 1px solid #28333f; color: #7d8a98; padding: 5px 9px; cursor: pointer; border-radius: 5px; }
.v11tab.on { background: #6fd0ff; color: #0d1117; border-color: #6fd0ff; }
.v11grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 14px; }
.v11card { border-radius: 14px; overflow: hidden; background: #111722; border: 1px solid #222c37; box-shadow: 0 12px 28px rgba(0,0,0,.42); }
.v11map { position: relative; height: 185px; background: #0c1620; overflow: hidden; }
.v11svg { width: 100%; height: 100%; display: block; }
.v11land path { fill: #32475b; stroke: #0c1620; stroke-width: .6; }
.v11halo { fill: #ffffff; opacity: .14; }
.v11pin { fill: #ffffff; stroke: rgba(0,0,0,.45); stroke-width: 1.6; }
.v11fade { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(13,18,24,0) 0%, rgba(13,18,24,0) 52%, rgba(13,18,24,.5) 74%, rgba(13,18,24,.88) 100%); }
.v11name { position: absolute; top: 11px; left: 13px; right: 13px; font-size: 13px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; color: #fff; text-shadow: 0 1px 7px rgba(0,0,0,.7); }
.v11foot { position: absolute; left: 0; right: 0; bottom: 0; padding: 10px 14px 12px; color: #cdd6e0; }
.v11val { font-size: 30px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; text-shadow: 0 1px 8px rgba(0,0,0,.55); }
.v11val span { font-size: 13px; font-weight: 700; margin-left: 2px; color: #aeb9c5; }
.v11loc { font-size: 11px; font-weight: 600; margin-top: 6px; color: #cbd4de; word-break: break-word; text-shadow: 0 1px 6px rgba(0,0,0,.7); }

/* -- 12 Cartogram in the Spotlight skin — colours driven by CSS variables -- */
.hx12 {
  --bg1: #1c1611; --bg2: #0c0a09; --bd: #2a2118; --ac: #e9b873; --tabbd: #3a2f22;
  --mut: #8a7860; --cardbg: #120d0a; --ocean: #100b08; --land: #3a3024;
  --txt: #f0e9dd; --foot: #c9bdac; --fademid: rgba(12,10,9,.5); --fadeend: rgba(12,10,9,.88);
  background: transparent;
  padding: 0; border: none; border-radius: 0; overflow: visible;
  font-family: "Bricolage Grotesque", sans-serif; color: var(--txt); }
/* clean colour schemes (fonts + sizes unchanged) */
.hx12.s-slate { --bg1: #161b22; --bg2: #0e1116; --bd: #262d37; --ac: #2970F6; --tabbd: #2b333d;
  --mut: #8995a4; --cardbg: #11151b; --ocean: #0e1218; --land: #2c3540; --txt: #e9eef4; --foot: #b7c1cd;
  --fademid: rgba(14,17,22,.5); --fadeend: rgba(14,17,22,.88); }
.hx12.s-sage { --bg1: #141911; --bg2: #0c0f0a; --bd: #252c1e; --ac: #aec38f; --tabbd: #2c3424;
  --mut: #8a9579; --cardbg: #10140d; --ocean: #0d110b; --land: #2c3526; --txt: #ecefe6; --foot: #b9c2ac;
  --fademid: rgba(12,15,10,.5); --fadeend: rgba(12,15,10,.88); }
.hx12.s-clay { --bg1: #1a1817; --bg2: #100f0e; --bd: #2c2926; --ac: #cf8259; --tabbd: #352f2a;
  --mut: #948b83; --cardbg: #161413; --ocean: #131110; --land: #34302c; --txt: #efe9e4; --foot: #c4bbb3;
  --fademid: rgba(16,15,14,.5); --fadeend: rgba(16,15,14,.88); }
.hx12head { display: flex; align-items: center; justify-content: flex-start; margin-bottom: 18px; }
.hx12kick { font-size: 11px; letter-spacing: .24em; text-transform: uppercase; color: var(--ac); font-weight: 700; }
.hx12tabs { display: flex; gap: 0; }
.v12tab { font-family: "Bricolage Grotesque", sans-serif; font-size: 11px; font-weight: 600; background: none; border: 1px solid var(--tabbd); color: var(--mut); padding: 4px 10px; border-radius: 999px; cursor: pointer; }
.v12tab.on { color: #fff; background: var(--ac); border-color: var(--ac); }
.v12grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 14px; }
.v12card { border-radius: 14px; overflow: hidden; background: var(--cardbg); border: 1px solid var(--bd); box-shadow: none; cursor: pointer; transition: transform .15s ease, border-color .15s ease; outline: none; }
.v12card:hover { transform: translateY(-2px); }
.v12card.sel { border-color: var(--ac); box-shadow: 0 0 0 2px var(--ac), var(--card-shadow); }
.v12card:focus-visible { border-color: var(--ac); }
.v12map { position: relative; height: 185px; background: var(--ocean); overflow: hidden; }
.v12svg { width: 100%; height: 100%; display: block; }
.v12land path { fill: var(--land); stroke: var(--ocean); stroke-width: .6; }
.v12halo { fill: var(--ac); opacity: .16; }
.v12pin { fill: var(--ac); stroke: #fff; stroke-width: 1.6; }
.v12fade { position: absolute; inset: 0; background: linear-gradient(to bottom, transparent 0%, transparent 52%, var(--fademid) 74%, var(--fadeend) 100%); }
.v12name { position: absolute; top: 11px; left: 13px; right: 13px; font-size: 13px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--txt); text-shadow: 0 1px 7px rgba(0,0,0,.7); }
.v12foot { position: absolute; left: 0; right: 0; bottom: 0; padding: 10px 14px 12px; color: var(--foot); }
.v12val { font-size: 30px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; color: var(--txt); text-shadow: 0 1px 8px rgba(0,0,0,.55); }
.v12val span { font-size: 13px; font-weight: 600; margin-left: 2px; color: var(--mut); }
.v12loc { font-size: 11px; font-weight: 600; margin-top: 6px; color: var(--foot); word-break: break-word; text-shadow: 0 1px 6px rgba(0,0,0,.7); }
@media (max-width: 760px) { .v3grid, .v7grid, .v10grid, .v11grid { grid-template-columns: 1fr 1fr; } }
/* map-card grid: 6 across, then 3, then 2 */
@media (max-width: 1000px) { .v12grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 600px) { .v12grid { grid-template-columns: repeat(2, 1fr); } }
/* small-screen tuning */
@media (max-width: 600px) {
  .wrap { padding: 44px 16px 72px; }
  h1 { font-size: 38px; letter-spacing: -.6px; margin-bottom: 26px; }
  h2 { font-size: 24px; margin: 40px 0 16px; }
  .vt { padding: 6px 10px; }
  .bars { grid-template-columns: minmax(0, 130px) 1fr auto; column-gap: 10px; }
  .topbar { top: 14px; }
}

.panel {
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 4px 0; margin-bottom: 24px; overflow: hidden;
}
.panel.nopad { padding: 0; }
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
table.matrix td.cell .v { position: relative; z-index: 1; display: block; }
table.matrix td.cell .loc { position: relative; z-index: 1; display: block; margin-top: 2px; font-size: 10.5px; font-weight: 400; color: var(--muted); }
table.matrix td.cell.win { box-shadow: inset 0 0 0 2px var(--good); border-radius: 4px; }
table.matrix td.cell.na { color: var(--muted); font-weight: 400; }
table.matrix th.col.sorted { color: var(--text); background: rgba(74,158,255,.14); }
table.matrix .sorted { border-left: 1px solid rgba(74,158,255,.55); border-right: 1px solid rgba(74,158,255,.55); }
table.matrix th.rowhead { text-align: left; }

.legend { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; padding: 0 16px 12px; }
.legend .bar { height: 10px; width: 160px; border-radius: 5px; background: linear-gradient(90deg, #1f9c4d, #d8c531, #d9534f); }

.bars { display: grid; grid-template-columns: max-content 1fr auto; align-items: center; column-gap: 12px; row-gap: 10px; padding: 0; }
.barrow { display: contents; }
.barrow .name { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.barrow .track { background: var(--panel-2); border-radius: 6px; height: 22px; overflow: hidden; }
.barrow .fill { height: 100%; border-radius: 6px; }
.barrow .fill.over {
  background-color: var(--bad);
  background-image: repeating-linear-gradient(45deg, rgba(0,0,0,.22) 0 7px, rgba(0,0,0,0) 7px 14px);
  display: flex; align-items: center; justify-content: flex-end; padding-right: 9px;
}
.over-label { font-size: 9.5px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: #fff; white-space: nowrap; text-shadow: 0 1px 2px rgba(0,0,0,.35); }
.barrow .val.over-val { color: var(--bad); }

/* region stats: list / map view switch */
.rp-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin: 52px 0 20px; }
.rp-head h2 { margin: 0; }
.viewtog { display: flex; flex-shrink: 0; }
.vt { font-family: inherit; font-size: 12px; font-weight: 600; padding: 6px 14px; background: var(--panel-2); border: 1px solid var(--border); color: var(--muted); cursor: pointer; }
.vt + .vt { border-left: none; }
.vt:first-child { border-radius: 8px 0 0 8px; }
.vt:last-child { border-radius: 0 8px 8px 0; }
.vt.on { background: var(--accent-2); border-color: var(--accent-2); color: #fff; }
.vt.on + .vt { border-left: 1px solid var(--accent-2); }
.mapwrap { background: var(--map-ocean); border-radius: 10px; overflow: hidden; position: relative; }
.map-name { position: absolute; top: 16px; left: max(20px, calc((100vw - 1180px) / 2 + 20px)); z-index: 2; font-size: 16px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--text); text-shadow: 0 1px 8px rgba(0,0,0,.55); pointer-events: none; }
.list-title { font-size: 16px; font-weight: 600; letter-spacing: .04em; color: var(--text); margin: 0 0 18px; }
[data-theme="light"] .map-name { text-shadow: 0 1px 6px rgba(255,255,255,.85); }
.mapwrap.full { margin-left: calc(50% - 50vw); margin-right: calc(50% - 50vw); border-radius: 0; margin-bottom: 34px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.regionmap { width: 100%; height: auto; display: block; }
.regionmap .mland { fill: var(--map-land); stroke: var(--map-ocean); stroke-width: .8; }
.regionmap .marc { fill: none; stroke-width: 1.6; stroke-opacity: .5; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.regionmap .mw { stroke: var(--map-ocean); stroke-width: 1.4; vector-effect: non-scaling-stroke; }
.regionmap .md1 { fill: var(--accent-2); stroke: #fff; stroke-width: 2; vector-effect: non-scaling-stroke; }
.regionmap .md1halo { fill: var(--accent-2); opacity: .16; }
[data-theme="dark"] .v12pin, [data-theme="dark"] .regionmap .md1 { stroke: rgba(0,0,0,.5); }
.regionmap .mw { cursor: pointer; transition: r .1s ease; }
.regionmap .mw:hover { r: 9; }
.maptip {
  position: fixed; z-index: 100; pointer-events: none;
  background: var(--panel); border: 1px solid var(--border); border-radius: 9px;
  padding: 8px 11px; box-shadow: 0 8px 24px rgba(0,0,0,.32);
}
.maptip[hidden] { display: none; }
.maptip-ms { font-size: 16px; font-weight: 800; color: var(--text); font-variant-numeric: tabular-nums; line-height: 1.1; }
.maptip-ms .u { font-size: 11px; font-weight: 600; color: var(--muted); margin-left: 2px; }
.maptip-loc { font-size: 11.5px; color: var(--muted); margin-top: 3px; font-family: "IBM Plex Mono", monospace; }
.barrow .val { text-align: left; font-variant-numeric: tabular-nums; font-weight: 600; font-size: 12.5px; white-space: nowrap; }
.barrow .val .num { display: inline-block; min-width: 5ch; text-align: right; }
.barrow .val .u { font-size: 10.5px; font-weight: 500; color: var(--muted); margin-left: 1px; }
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
const state = { db: (MODEL.databases[0] && MODEL.databases[0].key) || "all",
  metric: "p95", sort: "metric", dir: 1, matrixSort: "p95", matrixDir: 1, regionView: "list",
  heroM: { 1: "p95", 2: "p95", 3: "p95", 4: "p95", 5: "p95",
           6: "p95", 7: "p95", 8: "p95", 9: "p95", 10: "p95", 11: "p95",
           12: "p95", 13: "p95", 14: "p95", 15: "p95" } };

function fmt(v) { return v == null ? "—" : v.toFixed(v < 10 ? 1 : 0) + "ms"; }
function fmtNum(v) { return v == null ? "—" : v.toFixed(v < 10 ? 1 : 0); }
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function projXY(lat, lon, W, H) { return [(lon + 180) / 360 * W, (90 - lat) / 180 * H]; }
function arcPath(a, b) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const dist = Math.hypot(dx, dy) || 1;
  const curve = 0.16, nx = -dy / dist, ny = dx / dist;
  let cx = mx + nx * dist * curve, cy = my + ny * dist * curve;
  if (cy > my) { cx = mx - nx * dist * curve; cy = my - ny * dist * curve; } // bow north
  return "M" + a[0].toFixed(1) + " " + a[1].toFixed(1) +
    " Q" + cx.toFixed(1) + " " + cy.toFixed(1) + " " + b[0].toFixed(1) + " " + b[1].toFixed(1);
}
function placeCoord(placement) {
  const i = placement.indexOf(":");
  if (i < 0) return null;
  const prov = placement.slice(0, i), region = placement.slice(i + 1);
  return (MODEL.coords[prov] || {})[region] || null;
}
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
  return d.observedRegion || d.label;
}

function render() {
  const app = document.getElementById("app");
  app.innerHTML =
    header() +
    heroExplorations() +
    regionPanel() +
    metaFooter() +
    pageFooter();
  wire();
}

function header() {
  return '<div class="wrap-inner">' +
    '<h1>Cloudflare D1-to-Worker Latency Analytics</h1>' +
    '<h2 class="why">Why it matters</h2>' +
    '<div class="intro">' +
      '<div class="intro-text">' +
        '<p class="sub">When a user calls a Cloudflare Worker that queries a D1 database, D1 round trips can add ' +
          'significant latency to the final response, especially when a request runs multiple sequential D1 queries.</p>' +
        '<p class="idea-cap">Cloudflare Workers can be pinned to a specific placement region, which lets you place ' +
          'the Worker closer to D1. The tricky part is that placement names use third-party provider regions from AWS, ' +
          'GCP, and Azure. This benchmark helps find the best Worker region for a chosen D1 location.</p>' +
      '</div>' +
      '<div class="intro-fig">' + ideaDiagram() +
        '<p class="idea-link"><a href="https://developers.cloudflare.com/workers/configuration/placement/" ' +
          'target="_blank" rel="noopener">Read the official Cloudflare placement docs &#8594;</a></p>' +
      '</div>' +
    '</div>' +
  '</div>';
}

// Recreated from Cloudflare's Workers placement docs: a far user reaches the
// Worker in one hop, but the Worker talks to D1 many times per request — so the
// Worker should sit next to the database, not the user.
function ideaDiagram() {
  const pin = '<g class="pin"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/></g>';
  const node = (cx, loc, label, icon) =>
    '<g transform="translate(' + cx + ',0)">' +
      '<g transform="translate(-80,8)">' + pin + '</g>' +
      '<text class="loc" x="-50" y="26">' + loc + '</text>' +
      '<g transform="translate(0,132)">' + icon + '</g>' +
      '<text class="lbl" x="0" y="234" text-anchor="middle">' + label + '</text>' +
    '</g>';
  const browser =
    '<g class="ln">' +
      '<rect x="-36" y="-34" width="72" height="68" rx="6"/>' +
      '<line x1="-36" y1="-19" x2="36" y2="-19"/>' +
    '</g>' +
    '<circle class="dot" cx="-29" cy="-26.5" r="1.7"/><circle class="dot" cx="-23" cy="-26.5" r="1.7"/><circle class="dot" cx="-17" cy="-26.5" r="1.7"/>' +
    '<g class="ln"><circle cx="0" cy="-1" r="9"/><path d="M-15,27 a15,14 0 0 1 30,0"/></g>';
  const worker = '<g class="wkmark" transform="scale(5) translate(-8,-8)">' +
    '<path d="M6.21 12.293l-3.215-4.3 3.197-4.178-.617-.842-3.603 4.712-.005.603 3.62 4.847.623-.842z"></path>' +
    '<path d="M7.332 1.988H6.095l4.462 6.1-4.357 5.9h1.245L11.8 8.09 7.332 1.988z"></path>' +
    '<path d="M9.725 1.988H8.472l4.533 6.027-4.533 5.973h1.255l4.303-5.67v-.603L9.725 1.988z"></path>' +
  '</g>';
  const db =
    '<g class="ln">' +
      '<ellipse cx="0" cy="-22" rx="22" ry="8"/>' +
      '<path d="M-22,-22 V18 a22,8 0 0 0 44,0 V-22"/>' +
      '<path d="M-22,-9 a22,8 0 0 0 44,0"/><path d="M-22,4 a22,8 0 0 0 44,0"/>' +
    '</g>';
  const ln = (x1, y1, x2, y2) =>
    '<line class="arw" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" marker-end="url(#ah)"/>';
  const arrows =
    ln(250, 122, 505, 122) + ln(510, 138, 255, 138) +
    ln(662, 106, 768, 106) + ln(768, 122, 662, 122) + ln(662, 138, 768, 138) + ln(768, 154, 662, 154);
  return '<figure class="idea-fig">' +
    '<svg class="idea-svg" viewBox="66 4 816 240" preserveAspectRatio="xMidYMid meet" role="img" ' +
      'aria-label="A user reaches the Worker in one round trip; the Worker exchanges many round trips with the database.">' +
      '<defs><marker id="ah" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto" markerUnits="userSpaceOnUse">' +
        '<path class="arw-head" d="M0,0 L6,3 L0,6 Z"/></marker></defs>' +
      arrows +
      node(160, "Sydney, AU", "User", browser) +
      node(600, "Frankfurt, DE", "Worker", worker) +
      node(820, "Frankfurt, DE", "Database", db) +
    '</svg>' +
  '</figure>';
}

function metaFooter() {
  const r = MODEL.run;
  const b = r.benchmark || {};
  const num = (n) => (n == null ? "—" : Number(n).toLocaleString());
  const fmtTime = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  };
  let window = "—", duration = "—";
  if (r.startedAt && r.completedAt) {
    const s = new Date(r.startedAt), e = new Date(r.completedAt);
    const sameDay = s.toDateString() === e.toDateString();
    const endStr = sameDay ? e.toLocaleString([], { hour: "numeric", minute: "2-digit" }) : fmtTime(r.completedAt);
    window = fmtTime(r.startedAt) + " → " + endStr;
    const mins = Math.round((e - s) / 60000);
    duration = (mins >= 60 ? Math.floor(mins / 60) + "h " : "") + (mins % 60) + "m";
  }
  const measured = b.measuredRequests != null
    ? b.measuredRequests
    : Math.max.apply(null, MODEL.pairs.map(p => p.requestCount || 0).concat(0));
  const totalReq = MODEL.pairs.length * measured;
  const item = (k, v, cls) => '<div class="det' + (cls ? " " + cls : "") + '"><div class="det-k">' + k +
    '</div><div class="det-v' + (cls && cls.indexOf("mono") >= 0 ? " mono" : "") + '">' + v + '</div></div>';
  const items =
    item("Run window", esc(window), "wide") +
    item("Duration", duration) +
    item("D1 regions", num(MODEL.databases.length)) +
    item("Worker locations", num(MODEL.placements.length)) +
    item("Pairs tested", num(MODEL.pairs.length)) +
    item("Requests per pairing", num(measured)) +
    item("Queries per request", num(b.queriesPerRequest)) +
    item("Concurrency", num(b.concurrency)) +
    item("Warm-up per pairing", num(b.warmupRequests)) +
    item("Request timeout", b.requestTimeoutMs != null ? Math.round(b.requestTimeoutMs / 1000) + " s" : "—") +
    item("Total measured requests", num(totalReq));
  return '<section class="details">' +
    '<h2>How this was measured</h2>' +
    '<p class="sub">Every Worker location was benchmarked against every D1 region. For each pairing we sent ' +
      num(measured) + ' timed requests' + (b.warmupRequests ? ' (after ' + num(b.warmupRequests) + ' warm-ups)' : '') +
      ', each running ' + (b.queriesPerRequest ? num(b.queriesPerRequest) + ' sequential D1 queries' : 'its D1 queries') +
      ', and recorded the round-trip latency measured inside the Worker.</p>' +
    '<div class="detgrid">' + items + '</div>' +
  '</section>';
}

function pageFooter() {
  return '<footer class="pagefoot">' +
    '<div class="foot-left">' +
      '<span>Made by <a href="https://github.com/maxceem" target="_blank" rel="noopener">@maxceem</a></span>' +
      '<span class="foot-note">Not affiliated with Cloudflare.</span>' +
    '</div>' +
    '<span>Open source — <a href="' + esc(MODEL.repoUrl) + '" target="_blank" rel="noopener">fork it on GitHub</a>' +
    ' and rerun these analytics on your own Cloudflare account.</span>' +
  '</footer>';
}

function tabsPanel() {
  // Row 1: one tab per D1 region plus "All" (the ranked view across every pair).
  let dbTabs = '<button class="tab' + (state.db === "all" ? " active" : "") + '" data-db="all">All</button>';
  for (const d of MODEL.databases) {
    dbTabs += '<button class="tab' + (state.db === d.key ? " active" : "") + '" data-db="' + esc(d.key) + '">' +
      esc(dbLabel(d.key)) + '</button>';
  }
  // Row 2: metric tabs (no "All" — one is always selected).
  let mTabs = "";
  for (const m of METRICS.filter(x => x.key !== "avg")) {
    mTabs += '<button class="tab' + (state.metric === m.key ? " active" : "") + '" data-metric="' + m.key + '">' +
      esc(m.label) + '</button>';
  }
  return '<div class="tabs">' +
    '<div class="tabrow"><span class="tablabel">D1 region</span><div class="tabset">' + dbTabs + '</div></div>' +
    '<div class="tabrow"><span class="tablabel">Metric</span><div class="tabset">' + mTabs + '</div></div>' +
  '</div>';
}

function metricVal(p) { return p[state.metric]; }

// --- "Best worker regions": shared data helper + 5 concept explorations ---
function bestPerDb(metricKey) {
  return MODEL.databases.map(d => {
    let best = null;
    for (const p of MODEL.pairs) {
      if (p.dbKey !== d.key) continue;
      const v = p[metricKey];
      if (v == null) continue;
      if (!best || v < best.value) best = { value: v, placement: p.placement };
    }
    return { key: d.key, name: dbLabel(d.key), best: best };
  });
}
function byBest(a, b) {
  if (!a.best && !b.best) return 0;
  if (!a.best) return 1;
  if (!b.best) return -1;
  return a.best.value - b.best.value;
}
function heroRange(entries) {
  const v = entries.filter(e => e.best).map(e => e.best.value);
  const lo = v.length ? Math.min.apply(null, v) : 0;
  const hi = v.length ? Math.max.apply(null, v) : 1;
  return { lo: lo, hi: hi, span: (hi - lo) || 1 };
}
function heroTabs(ver, cls) {
  const sel = state.heroM[ver];
  let t = "";
  for (const m of METRICS.filter(x => x.key !== "avg")) {
    t += '<button class="' + cls + (sel === m.key ? " on" : "") + '" data-herov="' + ver +
      '" data-herok="' + m.key + '">' + m.key.toUpperCase() + '</button>';
  }
  return t;
}

function heroExplorations() {
  return '<h2>Best worker location per D1 region</h2>' +
    '<div class="hx-lab">' + heroV13() + '</div>';
}

// 01 — Editorial leaderboard (ranked typographic list on warm paper)
function heroV1() {
  const entries = bestPerDb(state.heroM[1]).slice().sort(byBest);
  let rows = "", i = 0;
  for (const e of entries) {
    i++;
    const num = (i < 10 ? "0" : "") + i;
    const val = e.best ? fmtNum(e.best.value) : "—";
    const loc = e.best ? esc(e.best.placement) : "no data";
    rows += '<div class="v1row' + (i === 1 ? " v1-lead" : "") + '">' +
      '<span class="v1rank">' + num + '</span>' +
      '<span class="v1region">' + esc(e.name) + '</span>' +
      '<span class="v1loc">' + loc + '</span>' +
      '<span class="v1val">' + val + '<i>ms</i></span>' +
    '</div>';
  }
  return '<section class="hx hx1">' +
    '<div class="hx1head">' +
      '<div><div class="hx1kick">01 — Leaderboard</div>' +
      '<div class="hx1title">Fastest worker per region</div></div>' +
      '<div class="hx1tabs">' + heroTabs(1, "v1tab") + '</div>' +
    '</div>' + rows +
  '</section>';
}

// 02 — Scale: every region plotted on one shared latency axis
function heroV2() {
  const entries = bestPerDb(state.heroM[2]).filter(e => e.best).slice().sort(byBest);
  const vals = entries.map(e => e.best.value);
  const lo = vals.length ? Math.min.apply(null, vals) : 0;
  const hi = vals.length ? Math.max.apply(null, vals) : 1;
  const span = (hi - lo) || 1;
  let marks = "";
  entries.forEach((e, idx) => {
    const pct = (e.best.value - lo) / span * 100;
    const dir = idx % 2 === 0 ? "up" : "down";
    marks += '<div class="v2mark ' + dir + '" style="left:' + pct + '%">' +
      '<div class="v2lab"><span class="v2reg">' + esc(e.name) + '</span>' +
        '<span class="v2v">' + fmtNum(e.best.value) + '<i>ms</i></span>' +
        '<span class="v2loc">' + esc(e.best.placement) + '</span></div>' +
      '<div class="v2stem"></div><div class="v2dot"></div>' +
    '</div>';
  });
  return '<section class="hx hx2">' +
    '<div class="hx2head"><span class="hx2kick">02 / Scale</span>' +
      '<span class="hx2sub">best latency on a shared axis</span>' +
      '<span class="hx2tabs">' + heroTabs(2, "v2tab") + '</span></div>' +
    '<div class="v2plot"><div class="v2track">' + marks + '</div>' +
      '<div class="v2end v2lo">' + fmtNum(lo) + 'ms</div>' +
      '<div class="v2end v2hi">' + fmtNum(hi) + 'ms</div></div>' +
  '</section>';
}

// 03 — Spotlight: one hero stat for the single best pairing + supporting list
function heroV3() {
  const entries = bestPerDb(state.heroM[3]).filter(e => e.best).slice().sort(byBest);
  const lead = entries[0];
  let rest = "";
  for (const e of entries.slice(1)) {
    rest += '<div class="v3row"><span class="v3reg">' + esc(e.name) + '</span>' +
      '<span class="v3loc">' + esc(e.best.placement) + '</span>' +
      '<span class="v3v">' + fmtNum(e.best.value) + '<i>ms</i></span></div>';
  }
  const leadHtml = lead ? '<div class="v3lead">' +
    '<div class="v3badge">★ Fastest pairing</div>' +
    '<div class="v3num">' + fmtNum(lead.best.value) + '<span>ms</span></div>' +
    '<div class="v3route"><b>' + esc(lead.name) + '</b><span class="v3arr">→</span>' +
      esc(lead.best.placement) + '</div>' +
  '</div>' : '';
  return '<section class="hx hx3">' +
    '<div class="hx3tabs">' + heroTabs(3, "v3tab") + '</div>' +
    '<div class="v3grid">' + leadHtml + '<div class="v3rest">' + rest + '</div></div>' +
  '</section>';
}

// 04 — Magnitude: industrial horizontal bar chart
function heroV4() {
  const entries = bestPerDb(state.heroM[4]).filter(e => e.best).slice().sort(byBest);
  const max = entries.length ? entries[entries.length - 1].best.value : 1;
  let rows = "";
  entries.forEach((e, i) => {
    const w = Math.max(4, e.best.value / max * 100);
    rows += '<div class="v4row' + (i === 0 ? " v4best" : "") + '">' +
      '<div class="v4reg">' + esc(e.name) + '</div>' +
      '<div class="v4barwrap"><div class="v4bar" style="width:' + w + '%"></div>' +
        '<span class="v4loc">' + esc(e.best.placement) + '</span></div>' +
      '<div class="v4val">' + fmtNum(e.best.value) + '<i>ms</i></div>' +
    '</div>';
  });
  return '<section class="hx hx4">' +
    '<div class="hx4head"><span class="hx4kick">04 · Magnitude</span>' +
      '<div class="hx4tabs">' + heroTabs(4, "v4tab") + '</div></div>' + rows +
  '</section>';
}

// 05 — Departures board: D1 → Worker framed as routes
function heroV5() {
  const entries = bestPerDb(state.heroM[5]).slice().sort(byBest);
  let rows = "";
  for (const e of entries) {
    const v = e.best ? fmtNum(e.best.value) : "—";
    const dest = e.best ? esc(e.best.placement) : "—";
    rows += '<div class="v5row"><span class="v5reg">' + esc(e.name) + '</span>' +
      '<span class="v5plane">✈</span><span class="v5dest">' + dest + '</span>' +
      '<span class="v5time">' + v + '<i>ms</i></span></div>';
  }
  return '<section class="hx hx5"><div class="v5board">' +
    '<div class="v5top"><span class="v5dot"></span>' +
      '<span class="v5title">D1 ▸ Worker Departures</span>' +
      '<span class="v5tabs">' + heroTabs(5, "v5tab") + '</span></div>' +
    '<div class="v5cols"><span>Region</span><span></span><span>Best worker</span><span>Latency</span></div>' +
    rows +
  '</div></section>';
}

// 06 — Signal traces: each D1↔worker pairing as a PCB circuit trace
function heroV6() {
  const entries = bestPerDb(state.heroM[6]);
  const r = heroRange(entries);
  let rows = "";
  for (const e of entries) {
    const has = !!e.best;
    const col = has ? lerpColor((e.best.value - r.lo) / r.span) : "#3a4a4a";
    const val = has ? fmtNum(e.best.value) : "—";
    const dest = has ? esc(e.best.placement) : "no signal";
    rows += '<div class="v6trace">' +
      '<span class="v6pad v6src">' + esc(e.name) + '</span>' +
      '<span class="v6wire" style="--c:' + col + '">' +
        '<span class="v6chip" style="color:' + col + ';border-color:' + col + '">' + val + '<i>ms</i></span>' +
      '</span>' +
      '<span class="v6pad v6dst">' + dest + '</span>' +
    '</div>';
  }
  return '<section class="hx hx6">' +
    '<div class="hx6head"><span class="hx6kick">06 ▮ Signal traces</span>' +
      '<span class="hx6sub">D1 ↔ best worker, etched</span>' +
      '<span class="hx6tabs">' + heroTabs(6, "v6tab") + '</span></div>' +
    '<div class="v6board">' + rows + '</div>' +
  '</section>';
}

// 07 — Dials: a speedometer gauge per D1, latency as the needle
function heroV7() {
  const entries = bestPerDb(state.heroM[7]);
  const r = heroRange(entries);
  let cards = "";
  for (const e of entries) {
    const has = !!e.best;
    const t = has ? (e.best.value - r.lo) / r.span : 0;
    const pct = has ? Math.max(5, Math.min(100, 12 + t * 88)) : 0;
    const col = has ? lerpColor(t) : "#2a3340";
    cards += '<div class="v7cell">' +
      '<div class="v7gauge" style="--p:' + pct + ';--c:' + col + '">' +
        '<div class="v7inner"><span class="v7v" style="color:' + col + '">' + (has ? fmtNum(e.best.value) : "—") +
          '</span><span class="v7u">ms</span></div>' +
      '</div>' +
      '<div class="v7reg">' + esc(e.name) + '</div>' +
      '<div class="v7loc">' + (has ? esc(e.best.placement) : "—") + '</div>' +
    '</div>';
  }
  return '<section class="hx hx7">' +
    '<div class="hx7head"><span class="hx7kick">07 — Dials</span>' +
      '<span class="hx7tabs">' + heroTabs(7, "v7tab") + '</span></div>' +
    '<div class="v7grid">' + cards + '</div>' +
  '</section>';
}

// 08 — Manifesto: each region as a bold typographic recommendation
function heroV8() {
  const entries = bestPerDb(state.heroM[8]);
  let lines = "";
  for (const e of entries) {
    const has = !!e.best;
    lines += '<div class="v8line">' +
      '<span class="v8reg">' + esc(e.name) + '</span>' +
      '<span class="v8mid">deploy on</span>' +
      '<span class="v8loc">' + (has ? esc(e.best.placement) : "—") + '</span>' +
      '<span class="v8at">·</span>' +
      '<span class="v8v">' + (has ? fmtNum(e.best.value) : "—") + '<i>ms</i></span>' +
    '</div>';
  }
  return '<section class="hx hx8">' +
    '<div class="hx8head"><span class="hx8kick">08 / Manifesto</span>' +
      '<span class="hx8tabs">' + heroTabs(8, "v8tab") + '</span></div>' +
    '<div class="v8body">' + lines + '</div>' +
  '</section>';
}

// 09 — Routing manifest: a terminal printout, one line per D1
function heroV9() {
  const k = state.heroM[9];
  const entries = bestPerDb(k);
  let lines = "";
  for (const e of entries) {
    const has = !!e.best;
    lines += '<div class="v9line">' +
      '<span class="v9reg">' + esc(e.name) + '</span>' +
      '<span class="v9arr">→</span>' +
      '<span class="v9loc">' + (has ? esc(e.best.placement) : "(none)") + '</span>' +
      '<span class="v9v">' + (has ? fmtNum(e.best.value) + "ms" : "—") + '</span>' +
    '</div>';
  }
  return '<section class="hx hx9"><div class="v9term">' +
    '<div class="v9bar"><span class="v9b r"></span><span class="v9b y"></span><span class="v9b g"></span>' +
      '<span class="v9file">d1-routes.sh</span>' +
      '<span class="v9tabs">' + heroTabs(9, "v9tab") + '</span></div>' +
    '<div class="v9body">' +
      '<div class="v9cmd"><span class="v9prompt">$</span> d1 routes --best --metric ' + esc(k) + '</div>' +
      '<div class="v9comment"># lowest-latency worker placement for each D1 region</div>' +
      lines +
    '</div></div></section>';
}

// 10 — Postage: each region as a collectible stamp with a latency denomination
function heroV10() {
  const entries = bestPerDb(state.heroM[10]);
  const r = heroRange(entries);
  let cards = "", i = 0;
  for (const e of entries) {
    i++;
    const has = !!e.best;
    const col = has ? lerpColor((e.best.value - r.lo) / r.span) : "#9a8a66";
    const rot = (i % 2 === 0 ? 1 : -1) * (1 + (i % 3));
    cards += '<div class="v10stamp" style="transform:rotate(' + rot + 'deg)">' +
      '<div class="v10perf"><div class="v10inner">' +
        '<div class="v10top"><span class="v10post">PAR AVION</span><span class="v10reg">' + esc(e.name) + '</span></div>' +
        '<div class="v10val" style="color:' + col + '">' + (has ? fmtNum(e.best.value) : "—") + '<span>ms</span></div>' +
        '<div class="v10loc">' + (has ? esc(e.best.placement) : "—") + '</div>' +
      '</div></div>' +
    '</div>';
  }
  return '<section class="hx hx10">' +
    '<div class="hx10head"><span class="hx10kick">10 ✦ Postage</span>' +
      '<span class="hx10tabs">' + heroTabs(10, "v10tab") + '</span></div>' +
    '<div class="v10grid">' + cards + '</div>' +
  '</section>';
}

// 11 — Cartogram cards: a cropped world map per D1 fading into a latency band
function heroV11() {
  const entries = bestPerDb(state.heroM[11]);
  const r = heroRange(entries);
  const B = MODEL.basemap;
  let landPaths = "";
  if (B) for (const d of B.paths) landPaths += '<path d="' + d + '"/>';
  let cards = "";
  for (const e of entries) {
    const has = !!e.best;
    const col = has ? lerpColor((e.best.value - r.lo) / r.span) : "#3a4654";
    const ll = (MODEL.d1coords || {})[(e.key || "").toLowerCase()];
    let map = "";
    if (ll && B) {
      const cx = (ll[1] + 180) / 360 * B.w;
      const cy = (90 - ll[0]) / 180 * B.h;
      const wide = (e.key || "").toLowerCase() === "oc";
      const vw = wide ? 560 : 320, vh = wide ? 400 : 230;
      let x0 = Math.max(0, Math.min(B.w - vw, cx - vw / 2));
      let y0 = Math.max(0, Math.min(B.h - vh, cy - vh / 2));
      map = '<svg class="v11svg" viewBox="' + x0 + ' ' + y0 + ' ' + vw + ' ' + vh +
        '" preserveAspectRatio="xMidYMid slice">' +
        '<g class="v11land">' + landPaths + '</g>' +
        '<circle class="v11halo" cx="' + cx + '" cy="' + cy + '" r="16"></circle>' +
        '<circle class="v11pin" cx="' + cx + '" cy="' + cy + '" r="8"></circle>' +
      '</svg>';
    }
    cards += '<div class="v11card">' +
      '<div class="v11map">' + map +
        '<div class="v11fade"></div>' +
        '<div class="v11name">' + esc(e.name) + '</div>' +
        '<div class="v11foot">' +
          '<div class="v11val" style="color:' + col + '">' + (has ? fmtNum(e.best.value) : "—") + '<span>ms</span></div>' +
          '<div class="v11loc">' + (has ? esc(e.best.placement) : "no data") + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  return '<section class="hx hx11">' +
    '<div class="hx11head"><span class="hx11kick">11 ◵ Cartogram</span>' +
      '<span class="hx11tabs">' + heroTabs(11, "v11tab") + '</span></div>' +
    '<div class="v11grid">' + cards + '</div>' +
  '</section>';
}

// 12 — Cartogram wearing the Spotlight block's skin; schemeCls recolours it.
function cartoSpot(ver, schemeCls, kicker) {
  const entries = bestPerDb(state.metric);
  const r = heroRange(entries);
  const B = MODEL.basemap;
  let landPaths = "";
  if (B) for (const d of B.paths) landPaths += '<path d="' + d + '"/>';
  let cards = "";
  for (const e of entries) {
    const has = !!e.best;
    const col = has ? lerpColor((e.best.value - r.lo) / r.span) : null;
    const ll = (MODEL.d1coords || {})[(e.key || "").toLowerCase()];
    let map = "";
    if (ll && B) {
      const cx = (ll[1] + 180) / 360 * B.w;
      const cy = (90 - ll[0]) / 180 * B.h;
      const wide = (e.key || "").toLowerCase() === "oc";
      const vw = wide ? 560 : 320, vh = wide ? 400 : 230;
      let x0 = Math.max(0, Math.min(B.w - vw, cx - vw / 2));
      let y0 = Math.max(0, Math.min(B.h - vh, cy - vh / 2));
      // Scale the dot to the crop width so it renders the same size on every card.
      const pr = vw / 70, hr = vw / 35, sw = vw / 350;
      map = '<svg class="v12svg" viewBox="' + x0 + ' ' + y0 + ' ' + vw + ' ' + vh +
        '" preserveAspectRatio="xMidYMid slice">' +
        '<g class="v12land">' + landPaths + '</g>' +
        '<circle class="v12halo" cx="' + cx + '" cy="' + cy + '" r="' + hr + '"></circle>' +
        '<circle class="v12pin" cx="' + cx + '" cy="' + cy + '" r="' + pr + '" stroke-width="' + sw + '"></circle>' +
      '</svg>';
    }
    const sel = state.db === e.key ? " sel" : "";
    cards += '<div class="v12card' + sel + '" data-db="' + esc(e.key) + '" tabindex="0" role="button" aria-pressed="' + (sel ? "true" : "false") + '">' +
      '<div class="v12map">' + map +
        '<div class="v12fade"></div>' +
        '<div class="v12name">' + esc(e.name) + '</div>' +
        '<div class="v12foot">' +
          '<div class="v12val"' + (col ? ' style="color:' + col + '"' : '') + '>' + (has ? fmtNum(e.best.value) : "—") + '<span>ms</span></div>' +
          '<div class="v12loc">' + (has ? esc(e.best.placement) : "no data") + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  return '<section class="hx hx12 ' + schemeCls + '">' +
    '<div class="hx12head"><span class="hx12kick">' + kicker + '</span>' +
      '<span class="hx12tabs">' + metricPills("vt") + '</span></div>' +
    '<div class="v12grid">' + cards + '</div>' +
  '</section>';
}
// Global metric ("P") filter pills — drives the cards and the stats below.
function metricPills(cls) {
  let t = "";
  for (const m of METRICS.filter(x => x.key !== "avg")) {
    t += '<button class="' + cls + (state.metric === m.key ? " on" : "") +
      '" data-metric="' + m.key + '">' + m.key.toUpperCase() + '</button>';
  }
  return t;
}
function heroV12() { return cartoSpot(12, "", "12 ◵ Cartogram · Spotlight skin"); }
function heroV13() { return cartoSpot(13, "s-slate", ""); }
function heroV14() { return cartoSpot(14, "s-sage", "14 ◵ Sage"); }
function heroV15() { return cartoSpot(15, "s-clay", "15 ◵ Clay"); }

function matrixPanel() {
  const dbs = MODEL.databases;
  const order = ["min", "p50", "p90", "p95", "p99", "max"];
  const cols = order.map(k => METRICS.find(m => m.key === k)).filter(Boolean);
  // For each D1 region and each metric, find the best (lowest) value across all
  // Worker placements and remember which placement achieved it.
  const bestByDbMetric = {}; // dbKey -> metricKey -> { value, placement }
  for (const d of dbs) {
    const perMetric = {};
    const dbPairs = MODEL.pairs.filter(x => x.dbKey === d.key);
    for (const m of cols) {
      let best = null;
      for (const p of dbPairs) {
        const v = p[m.key];
        if (v == null) continue;
        if (!best || v < best.value) best = { value: v, placement: p.placement };
      }
      perMetric[m.key] = best;
    }
    bestByDbMetric[d.key] = perMetric;
  }
  // Per-metric colour range, computed across each column's best values.
  const ranges = {};
  for (const m of cols) {
    const vals = dbs.map(d => bestByDbMetric[d.key][m.key]).filter(b => b).map(b => b.value);
    const lo = vals.length ? Math.min.apply(null, vals) : 0;
    const hi = vals.length ? Math.max.apply(null, vals) : 1;
    ranges[m.key] = { lo, span: (hi - lo) || 1 };
  }
  // Optionally sort the D1 rows by a clicked metric column's best value.
  let orderedDbs = dbs.slice();
  if (state.matrixSort) {
    orderedDbs.sort((a, b) => {
      const av = (bestByDbMetric[a.key][state.matrixSort] || {}).value;
      const bv = (bestByDbMetric[b.key][state.matrixSort] || {}).value;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * state.matrixDir;
    });
  }
  const arrow = m => state.matrixSort === m ? (state.matrixDir === 1 ? " ▲" : " ▼") : "";
  let head = '<tr><th class="rowhead l">D1 region ＼ Metric (ms)</th>';
  for (const m of cols) head += '<th class="col' + (state.matrixSort === m.key ? " sorted" : "") + '" data-msort="' + m.key + '">' + esc(m.label) + arrow(m.key) + '</th>';
  head += '</tr>';
  let rows = "";
  for (const d of orderedDbs) {
    rows += '<tr><th class="rowhead l"><span class="tag d1">' + esc(dbLabel(d.key)) + '</span></th>';
    for (const m of cols) {
      const sorted = state.matrixSort === m.key ? " sorted" : "";
      const best = bestByDbMetric[d.key][m.key];
      if (!best) { rows += '<td class="cell na' + sorted + '">—</td>'; continue; }
      const r = ranges[m.key];
      const t = (best.value - r.lo) / r.span;
      const bg = lerpColor(t);
      rows += '<td class="cell' + sorted + '" style="background:' + bg + '22" title="' +
        esc(dbLabel(d.key)) + ' — best ' + esc(m.label) + ': ' + fmt(best.value) + ' via ' + esc(best.placement) + '">' +
        '<span class="v" style="color:' + bg + '">' + fmtNum(best.value) + '</span>' +
        '<span class="loc">' + esc(best.placement) + '</span></td>';
    }
    rows += '</tr>';
  }
  return '<h2>Best latency per D1 region</h2>' +
    '<div class="panel nopad">' +
      '<div class="matrix-scroll"><table class="matrix"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>' +
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
    { key: "placement", label: "Worker location", l: true },
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

  // Global scale across every D1 x Worker pair for the current metric, so bar
  // lengths and colours are comparable when switching between D1 regions.
  const allVals = MODEL.pairs.map(metricVal).filter(v => v != null);
  const gMin = allVals.length ? Math.min.apply(null, allVals) : 0;
  const gMax = allVals.length ? Math.max.apply(null, allVals) : 1;
  // Robust upper bound (Tukey fence) so a few extreme outliers (timeouts/cold
  // starts) don't compress the scale; values above it clamp to a hatched bar.
  const sortedAll = allVals.slice().sort((a, b) => a - b);
  const q1 = quantile(sortedAll, 0.25), q3 = quantile(sortedAll, 0.75);
  const cap = q3 + 1.5 * (q3 - q1);
  const scaleMax = Math.max(gMin + 1, Math.min(gMax, cap));
  const span = (scaleMax - gMin) || 1;

  // bar chart
  let bars = "";
  for (const p of ranked) {
    const v = metricVal(p);
    const over = v > scaleMax;
    const w = over ? 100 : Math.max(2, (v / scaleMax) * 100);
    const t = Math.min(1, (v - gMin) / span);
    const col = lerpColor(t);
    const isBest = p === winner;
    const fillStyle = over ? 'width:100%' : 'width:' + w + '%;background:' + col;
    const fillInner = over ? '<span class="over-label">off scale &#8250;&#8250;</span>' : '';
    bars += '<div class="barrow ' + (isBest ? "best" : "") + '">' +
      '<div class="name" title="' + esc(p.placement) + '">' + esc(p.placement) + '</div>' +
      '<div class="track"><div class="fill' + (over ? " over" : "") + '" style="' + fillStyle + '"' +
        (over ? ' title="off scale (above ' + fmt(scaleMax) + ')"' : '') + '>' + fillInner + '</div></div>' +
      '<div class="val' + (over ? " over-val" : "") + '"><span class="num">' + fmtNum(v) + '</span><span class="u">ms</span></div>' +
    '</div>';
  }

  return '<div class="mapwrap full"><div class="map-name">' + esc(dbLabel(d.key)) + '</div>' +
      regionMap(d, ranked, gMin, scaleMax, span) + '</div>' +
    '<div class="list-title">' + esc(dbLabel(d.key)) + ' to worker locations</div>' +
    '<div class="bars">' + bars + '</div>';
}

// World map for one D1: the region marker plus an arc to every worker placement.
function regionMap(d, ranked, gMin, scaleMax, span) {
  const B = MODEL.basemap;
  if (!B) return '<div class="empty">No basemap available.</div>';
  const W = B.w, H = B.h;
  const d1ll = (MODEL.d1coords || {})[(d.key || "").toLowerCase()];
  let land = "";
  for (const path of B.paths) land += '<path class="mland" d="' + path + '"/>';
  // Crop the empty polar bands (above ~80°N / below ~58°S) so the full-width
  // map isn't needlessly tall; every data city sits inside this band.
  const yTop = (90 - 80) / 180 * H, yBot = (90 + 58) / 180 * H;
  const vb = "0 " + yTop.toFixed(1) + " " + W + " " + (yBot - yTop).toFixed(1);
  if (!d1ll) return '<svg class="regionmap" viewBox="' + vb + '"><g>' + land + '</g></svg>';
  const d1pt = projXY(d1ll[0], d1ll[1], W, H);
  let arcs = "", dots = "";
  for (const p of ranked) {
    const c = placeCoord(p.placement);
    if (!c) continue;
    const pt = projXY(c[0], c[1], W, H);
    const v = metricVal(p);
    const over = v > scaleMax;
    const col = over ? "#e5534b" : lerpColor(Math.min(1, (v - gMin) / span));
    arcs += '<path class="marc" d="' + arcPath(d1pt, pt) + '" stroke="' + col + '"></path>';
    dots += '<circle class="mw" cx="' + pt[0].toFixed(1) + '" cy="' + pt[1].toFixed(1) +
      '" r="7" fill="' + col + '" data-ms="' + fmtNum(v) + '" data-loc="' + esc(p.placement) + '"></circle>';
  }
  dots += '<circle class="md1halo" cx="' + d1pt[0].toFixed(1) + '" cy="' + d1pt[1].toFixed(1) + '" r="22"></circle>' +
    '<circle class="md1" cx="' + d1pt[0].toFixed(1) + '" cy="' + d1pt[1].toFixed(1) + '" r="11">' +
    '<title>D1 ' + esc(dbLabel(d.key)) + '</title></circle>';
  return '<svg class="regionmap" viewBox="' + vb + '" preserveAspectRatio="xMidYMid meet">' +
    '<g>' + land + '</g>' + arcs + dots + '</svg>';
}

function wire() {
  // Global metric ("P") filter — re-renders cards and the stats below.
  document.querySelectorAll("[data-metric]").forEach(t => {
    t.onclick = () => { state.metric = t.getAttribute("data-metric"); render(); };
  });
  // Custom tooltip for worker dots on the map.
  const map = document.querySelector(".regionmap");
  const tip = document.getElementById("maptip");
  if (map && tip) {
    const msEl = tip.querySelector(".maptip-ms"), locEl = tip.querySelector(".maptip-loc");
    map.addEventListener("mousemove", (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains("mw")) {
        msEl.innerHTML = t.getAttribute("data-ms") + '<span class="u">ms</span>';
        locEl.textContent = t.getAttribute("data-loc");
        tip.hidden = false;
        const w = tip.offsetWidth || 120;
        let x = e.clientX + 14;
        if (x + w > window.innerWidth - 8) x = e.clientX - 14 - w;
        tip.style.left = x + "px";
        tip.style.top = (e.clientY + 16) + "px";
      } else {
        tip.hidden = true;
      }
    });
    map.addEventListener("mouseleave", () => { tip.hidden = true; });
  }
  // Clicking a map card selects that D1 region for the stats below.
  document.querySelectorAll(".v12card[data-db]").forEach(c => {
    const pick = () => { state.db = c.getAttribute("data-db"); state.sort = "metric"; state.dir = 1; render(); };
    c.onclick = pick;
    c.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
  });
  document.querySelectorAll("th[data-sort]").forEach(th => {
    th.onclick = () => {
      const key = th.getAttribute("data-sort");
      if (state.sort === key) state.dir *= -1;
      else { state.sort = key; state.dir = 1; }
      render();
    };
  });
  document.querySelectorAll("th[data-msort]").forEach(th => {
    th.onclick = () => {
      const key = th.getAttribute("data-msort");
      if (state.matrixSort === key) state.matrixDir *= -1;
      else { state.matrixSort = key; state.matrixDir = 1; }
      render();
    };
  });
}

// theme switcher (persisted)
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

// wrap content for max-width consistency
document.getElementById("app").className = "wrap";
render();
`;
