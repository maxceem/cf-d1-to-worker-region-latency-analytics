#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { registerResource, unregisterResource } from "./clean-resources.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_CONFIG_PATH = path.join(ROOT_DIR, "worker-region-finder.config.json");
const FINDER_RESOURCE_SCOPE = "finder";
const MAX_WORKER_NAME_LENGTH = 54;

let cachedWranglerInvocation;
let activeCleanup;
let cleanupStarted = false;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const startedAt = new Date();
  const runId = toRunId(startedAt);
  const config = await loadConfig(args);
  const databaseSelector = resolveDatabaseSelector(args);
  validateConfig(config);

  const auth = readAuthFromEnv();
  const accountId = await resolveAccountId(auth, config.accountId);
  const database = await resolveDatabase(auth, accountId, databaseSelector);
  const databaseKey = makeDatabaseKey(database.name);
  const observation = await observeD1(auth, accountId, database.id, config.d1ObservationQueries);
  const providerRegionMap = await loadProviderRegionMap();
  const placementContext = resolvePlacementContext(observation, providerRegionMap);
  const workerPlacements = placementContext.providerRegions;
  const batches = chunk(workerPlacements, config.maxWorkersPerBatch);
  const resultsDir = path.resolve(ROOT_DIR, config.resultsDir, runId);
  const tempDir = path.resolve(ROOT_DIR, ".finder-tmp", runId);
  const deployedWorkers = [];

  activeCleanup = { accountId, config, deployedWorkers };
  installTerminationHandlers();

  await mkdir(resultsDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });

  const raw = {
    run: {
      id: runId,
      startedAt: startedAt.toISOString(),
      completedAt: null,
      accountId,
      config,
      finder: {
        placementContext
      },
      warnings: []
    },
    databases: [
      {
        key: databaseKey,
        label: observation.region || database.name,
        id: database.id,
        name: database.name,
        createdByBenchmark: false,
        targetLocation: observation.region,
        observedRegion: observation.region,
        jurisdiction: database.jurisdiction,
        bindingName: "DB",
        rawInfo: database.raw,
        finder: {
          runningInRegion: database.running_in_region,
          primaryLocationHint: database.primary_location_hint,
          observedColo: observation.colo,
          observation
        }
      }
    ],
    workerPlacements,
    batches: [],
    warmup: {
      [databaseKey]: {}
    },
    measured: {
      [databaseKey]: {}
    }
  };

  log(`Account: ${accountId}`);
  log(`D1 database: ${database.name} (${database.id})`);
  log(`Observed D1: region=${observation.region || "unknown"} colo=${observation.colo || "unknown"}`);
  log(`Worker placements: ${workerPlacements.join(", ")}`);

  try {
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const placements = batches[batchIndex];
      const batchWorkers = [];
      log(`Starting Worker batch ${batchIndex + 1}/${batches.length} (${placements.length} Workers).`);

      try {
        for (const placement of placements) {
          const worker = await deployWorker({
            accountId,
            config,
            database,
            placement,
            runId,
            tempDir,
            deployedWorkers
          });
          batchWorkers.push(worker);
        }
        raw.batches.push({ index: batchIndex, placements, workers: batchWorkers });
        await persistRaw(resultsDir, raw);

        if (config.propagationSeconds > 0) {
          log(`Waiting ${config.propagationSeconds}s for Worker propagation.`);
          await sleep(config.propagationSeconds * 1000);
        }

        for (const worker of batchWorkers) {
          log(`Warm-up: ${worker.placement} (${config.benchmark.warmupRequests} requests).`);
          raw.warmup[databaseKey][worker.placement] = await runRequests({
            worker,
            requests: config.benchmark.warmupRequests,
            queriesPerRequest: config.benchmark.queriesPerRequest,
            timeoutMs: config.benchmark.requestTimeoutMs
          });
          await persistRaw(resultsDir, raw);

          log(`Measurement: ${worker.placement} (${config.benchmark.measuredRequests} requests).`);
          raw.measured[databaseKey][worker.placement] = await runRequests({
            worker,
            requests: config.benchmark.measuredRequests,
            queriesPerRequest: config.benchmark.queriesPerRequest,
            timeoutMs: config.benchmark.requestTimeoutMs
          });
          await persistRaw(resultsDir, raw);
        }
      } finally {
        if (config.cleanupWorkers) {
          await cleanupWorkers(batchWorkers.map((worker) => worker.name), accountId);
          removeDeployedWorkers(deployedWorkers, batchWorkers.map((worker) => worker.name));
        }
      }
    }

    raw.run.completedAt = new Date().toISOString();
    const summary = summarizeRun(raw);
    await writeFile(path.join(resultsDir, "raw.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await writeFile(path.join(resultsDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    await rm(path.join(resultsDir, "raw.partial.json"), { force: true });
    await buildAndOpenSite({ config, resultsDir });
    printSummary(summary, resultsDir);
  } finally {
    await persistPartialIfNeeded(resultsDir, raw);
    if (config.cleanupWorkers && deployedWorkers.length > 0) {
      await cleanupWorkers(deployedWorkers, accountId);
    } else if (deployedWorkers.length > 0) {
      log(`Keeping ${deployedWorkers.length} temporary Workers because cleanupWorkers=false.`);
    }
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--config" || arg === "-c") args.config = nextValue(argv, ++index, arg);
    else if (arg === "--database-id") args.databaseId = nextValue(argv, ++index, arg);
    else if (arg === "--database-name") args.databaseName = nextValue(argv, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function nextValue(argv, index, name) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

async function loadConfig(args) {
  const configPath = args.config ? path.resolve(process.cwd(), args.config) : DEFAULT_CONFIG_PATH;
  return JSON.parse(await readFile(configPath, "utf8"));
}

function resolveDatabaseSelector(args) {
  if (args.databaseId && args.databaseName) {
    throw new Error("Use either --database-id or --database-name, not both.");
  }
  if (args.databaseId) return { id: args.databaseId };
  if (args.databaseName) return { name: args.databaseName };
  throw new Error("Provide --database-id or --database-name.");
}

function validateConfig(config) {
  requirePlainObject(config, "config");
  if ("database" in config) {
    throw new Error("Select the D1 database with --database-id or --database-name.");
  }
  const allowedConfigFields = new Set([
    "accountId",
    "d1ObservationQueries",
    "workerNamePrefix",
    "workerCompatibilityDate",
    "workerCompatibilityFlags",
    "workerObservabilityEnabled",
    "benchmark",
    "maxWorkersPerBatch",
    "propagationSeconds",
    "cleanupWorkers",
    "workerDeployRetry",
    "resultsDir",
    "siteOutputPath",
    "openSiteAfterRun"
  ]);
  for (const key of Object.keys(config)) {
    if (!allowedConfigFields.has(key)) {
      throw new Error(`Unknown config field: ${key}`);
    }
  }
  if (config.accountId !== undefined && config.accountId !== "") {
    requireString(config.accountId, "accountId");
  }
  requirePositiveInteger(config.d1ObservationQueries, "d1ObservationQueries");
  requireString(config.workerNamePrefix, "workerNamePrefix");
  requireString(config.workerCompatibilityDate, "workerCompatibilityDate");
  requireArray(config.workerCompatibilityFlags, "workerCompatibilityFlags");
  requireBoolean(config.workerObservabilityEnabled, "workerObservabilityEnabled");
  requirePlainObject(config.benchmark, "benchmark");
  requirePositiveInteger(config.benchmark.warmupRequests, "benchmark.warmupRequests");
  requirePositiveInteger(config.benchmark.measuredRequests, "benchmark.measuredRequests");
  requirePositiveInteger(config.benchmark.minSuccessfulRequests, "benchmark.minSuccessfulRequests");
  if (config.benchmark.minSuccessfulRequests > config.benchmark.measuredRequests) {
    throw new Error("benchmark.minSuccessfulRequests cannot be greater than benchmark.measuredRequests.");
  }
  requirePositiveInteger(config.benchmark.queriesPerRequest, "benchmark.queriesPerRequest");
  requirePositiveInteger(config.benchmark.requestTimeoutMs, "benchmark.requestTimeoutMs");
  requirePositiveInteger(config.maxWorkersPerBatch, "maxWorkersPerBatch");
  if (!Number.isInteger(config.propagationSeconds) || config.propagationSeconds < 0) {
    throw new Error("propagationSeconds must be a non-negative integer.");
  }
  requireBoolean(config.cleanupWorkers, "cleanupWorkers");
  requireString(config.resultsDir, "resultsDir");
  requireString(config.siteOutputPath, "siteOutputPath");
  requireBoolean(config.openSiteAfterRun, "openSiteAfterRun");
  requirePlainObject(config.workerDeployRetry, "workerDeployRetry");
  requirePositiveInteger(config.workerDeployRetry.attempts, "workerDeployRetry.attempts");
  requirePositiveInteger(config.workerDeployRetry.delayMs, "workerDeployRetry.delayMs");
}

async function loadProviderRegionMap() {
  const map = JSON.parse(await readFile(path.join(ROOT_DIR, "data", "finder", "d1-provider-region-map.json"), "utf8"));
  validateProviderRegionMap(map);
  return map;
}

function readAuthFromEnv() {
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  const globalKey = process.env.CLOUDFLARE_API_KEY || process.env.CF_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL || process.env.CF_EMAIL;
  if (token) return { mode: "token", token };
  if (globalKey && email) return { mode: "global-key", globalKey, email };
  throw new Error("Set CLOUDFLARE_API_TOKEN. Legacy global key auth requires CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL.");
}

function authHeaders(auth) {
  if (auth.mode === "token") return { Authorization: `Bearer ${auth.token}` };
  return { "X-Auth-Email": auth.email, "X-Auth-Key": auth.globalKey };
}

async function resolveAccountId(auth, configuredAccountId) {
  const envAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
  if (configuredAccountId) return configuredAccountId;
  if (envAccountId) return envAccountId;

  const response = await cfRequest(auth, "/accounts?per_page=50");
  const accounts = Array.isArray(response.result) ? response.result : [];
  if (accounts.length === 1) return accounts[0].id;
  if (accounts.length === 0) {
    throw new Error("The Cloudflare credential can list no accounts.");
  }

  const choices = accounts.map((account) => `${account.name} (${account.id})`).join(", ");
  throw new Error(`The credential can access multiple accounts. Set accountId or CLOUDFLARE_ACCOUNT_ID. Accounts: ${choices}`);
}

async function resolveDatabase(auth, accountId, databaseConfig) {
  if (databaseConfig.id) {
    return normalizeDatabase((await cfRequest(auth, `/accounts/${accountId}/d1/database/${databaseConfig.id}`)).result);
  }

  const databases = await listDatabases(auth, accountId);
  const matches = databases.filter((database) => database.name === databaseConfig.name);
  if (matches.length === 0) throw new Error(`D1 database not found by name: ${databaseConfig.name}`);
  if (matches.length > 1) throw new Error(`Multiple D1 databases matched ${databaseConfig.name}; use database.id.`);
  return matches[0];
}

async function listDatabases(auth, accountId) {
  const databases = [];
  let page = 1;
  while (true) {
    const response = await cfRequest(auth, `/accounts/${accountId}/d1/database?per_page=100&page=${page}`);
    const pageDatabases = Array.isArray(response.result) ? response.result.map(normalizeDatabase) : [];
    databases.push(...pageDatabases);
    const totalPages = Number(response.result_info?.total_pages);
    if (Number.isFinite(totalPages) && totalPages > 0) {
      if (page >= totalPages) break;
    } else if (pageDatabases.length < 100) {
      break;
    }
    page += 1;
  }
  return databases;
}

function normalizeDatabase(database) {
  return {
    id: database.uuid || database.id || database.database_id,
    name: database.name || database.database_name,
    jurisdiction: database.jurisdiction,
    running_in_region: database.running_in_region,
    primary_location_hint: database.primary_location_hint,
    raw: database
  };
}

async function observeD1(auth, accountId, databaseId, observationQueries) {
  const observations = [];
  for (let index = 0; index < observationQueries; index += 1) {
    const response = await cfRequest(auth, `/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT 1 AS ok;" })
    });
    const result = Array.isArray(response.result) ? response.result[0] : response.result;
    const meta = result?.meta ?? response.result?.meta;
    observations.push({
      servedByRegion: meta?.served_by_region || null,
      servedByColo: meta?.served_by_colo || null,
      sqlDurationMs: meta?.timings?.sql_duration_ms ?? meta?.duration ?? null,
      rawMeta: meta || null
    });
  }

  return {
    region: mostCommon(observations.map((item) => item.servedByRegion).filter(Boolean)),
    colo: mostCommon(observations.map((item) => item.servedByColo).filter(Boolean)),
    observations
  };
}

function resolvePlacementContext(observation, providerRegionMap) {
  const colo = observation.colo ? observation.colo.toUpperCase() : null;
  const region = observation.region ? observation.region.toLowerCase() : null;
  if (!region) {
    throw new Error(
      "Could not observe the D1 served_by_region value needed to select Worker placements."
    );
  }

  const bucket = providerRegionMap[region];
  if (!bucket) {
    throw new Error(`No Worker placement list is configured for observed D1 region: ${region}`);
  }

  return {
    source: "d1-provider-region-map",
    colo,
    region,
    label: bucket.label,
    providerRegions: bucket.providerRegions
  };
}

async function deployWorker({ accountId, config, database, placement, runId, tempDir, deployedWorkers }) {
  const workerName = makeWorkerName(config.workerNamePrefix, runId, placement);
  const workerDir = path.join(tempDir, workerName);
  const configPath = path.join(workerDir, "wrangler.json");
  await mkdir(workerDir, { recursive: true });

  const wranglerConfig = {
    $schema: "https://unpkg.com/wrangler/config-schema.json",
    account_id: accountId,
    name: workerName,
    main: path.relative(workerDir, path.join(SCRIPT_DIR, "finder-worker-source.mjs")),
    compatibility_date: config.workerCompatibilityDate,
    compatibility_flags: config.workerCompatibilityFlags,
    placement: {
      mode: "targeted",
      region: placement
    },
    observability: {
      enabled: config.workerObservabilityEnabled
    },
    vars: {
      WORKER_PLACEMENT: placement,
      QUERIES_PER_REQUEST: String(config.benchmark.queriesPerRequest)
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: database.name,
        database_id: database.id
      }
    ]
  };

  await writeFile(configPath, `${JSON.stringify(wranglerConfig, null, 2)}\n`, "utf8");
  deployedWorkers.push(workerName);
  await registerResource({
    type: "worker",
    accountId,
    runId,
    name: workerName,
    metadata: { scope: FINDER_RESOURCE_SCOPE, placement }
  });
  log(`Deploying Worker ${workerName} (${placement}).`);
  const deployOutput = await deployWorkerWithRetry(workerName, placement, configPath, accountId, config.workerDeployRetry);
  const url = extractWorkersDevUrl(deployOutput);
  if (!url) throw new Error(`Could not find workers.dev URL in Wrangler output for ${workerName}.`);
  await registerResource({
    type: "worker",
    accountId,
    runId,
    name: workerName,
    url,
    metadata: { scope: FINDER_RESOURCE_SCOPE, placement }
  });
  return { name: workerName, placement, url, configPath };
}

async function deployWorkerWithRetry(workerName, placement, configPath, accountId, retry) {
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    try {
      return await runWrangler(["deploy", "--config", configPath, "--minify"], {
        CLOUDFLARE_ACCOUNT_ID: accountId
      });
    } catch (error) {
      if (attempt >= retry.attempts || !isRetryableWorkerDeployError(error)) throw error;
      log(`Deploy failed while Cloudflare prepared bindings; retrying ${workerName} (${placement}).`);
      await sleep(retry.delayMs);
    }
  }
}

function isRetryableWorkerDeployError(error) {
  const text = `${error?.message || ""}\n${error?.stdout || ""}\n${error?.stderr || ""}`;
  return /binding\s+\S+\s+of type d1 failed to generate/i.test(text) || /\bcode:\s*10021\b/i.test(text);
}

async function runRequests({ worker, requests, queriesPerRequest, timeoutMs }) {
  const results = [];
  for (let requestIndex = 0; requestIndex < requests; requestIndex += 1) {
    results.push(await callMeasure(worker, queriesPerRequest, timeoutMs));
  }
  return results;
}

async function callMeasure(worker, queriesPerRequest, timeoutMs) {
  const url = new URL("/measure", worker.url);
  url.searchParams.set("queries", String(queriesPerRequest));
  url.searchParams.set("nonce", crypto.randomUUID());

  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "cache-control": "no-store" }
    });
    const clientMs = performance.now() - started;
    const placementHeader = response.headers.get("cf-placement");
    const placement = parsePlacementHeader(placementHeader);
    const text = await response.text();
    const body = parseJsonBody(text);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        clientMs,
        placementHeader,
        placementMode: placement.placementMode,
        placementColo: placement.placementColo,
        error: body?.error || `HTTP ${response.status}`,
        body
      };
    }

    return {
      ok: true,
      status: response.status,
      clientMs,
      placementHeader,
      placementMode: placement.placementMode,
      placementColo: placement.placementColo,
      body
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      clientMs: performance.now() - started,
      error: error.name === "AbortError" ? "request_timeout" : error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeRun(raw) {
  const database = raw.databases[0];
  const measured = raw.measured[database.key] || {};
  const ranked = Object.entries(measured).map(([placement, requests]) => {
    const successes = requests.filter((request) => request?.ok);
    const errors = requests.filter((request) => !request?.ok);
    const perQueryNetworkMs = successes.flatMap((request) => request.body?.perQueryNetworkMs || []);
    const perQueryMs = successes.flatMap((request) => request.body?.perQueryMs || []);
    const sqlDurations = successes.flatMap((request) => request.body?.d1?.sqlDurations || []);
    const workerColos = countValues(successes.map((request) => request.body?.workerColo).filter(Boolean));
    const placementColos = countValues(successes.map((request) => request.placementColo).filter(Boolean));
    const d1Regions = mergeCounts(successes.map((request) => request.body?.d1?.regions));
    const d1Colos = mergeCounts(successes.map((request) => request.body?.d1?.colos));

    return {
      placement,
      requestCount: requests.length,
      successCount: successes.length,
      errorCount: errors.length,
      errors: countValues(errors.map((error) => error.error || `HTTP ${error.status}`)),
      p50DbNetworkMs: percentile(perQueryNetworkMs, 50),
      p90DbNetworkMs: percentile(perQueryNetworkMs, 90),
      p95DbNetworkMs: percentile(perQueryNetworkMs, 95),
      avgDbNetworkMs: average(perQueryNetworkMs),
      minDbNetworkMs: min(perQueryNetworkMs),
      maxDbNetworkMs: max(perQueryNetworkMs),
      stddevDbNetworkMs: stddev(perQueryNetworkMs),
      avgRawQueryMs: average(perQueryMs),
      avgD1SqlDurationMs: average(sqlDurations),
      workerColos,
      placementColos,
      d1Regions,
      d1Colos
    };
  }).sort((a, b) => {
    if (a.successCount === 0 && b.successCount > 0) return 1;
    if (a.successCount > 0 && b.successCount === 0) return -1;
    return compareNullable(a.p50DbNetworkMs, b.p50DbNetworkMs) ||
      compareNullable(a.avgDbNetworkMs, b.avgDbNetworkMs);
  }).map((item, index) => ({ rank: index + 1, ...item }));

  const best = ranked.find((item) => item.successCount > 0) || null;
  return {
    run: raw.run,
    database,
    ranked,
    recommendation: best
      ? `Pin the Worker to ${best.placement} based on the lowest p50 D1 network latency in this run.`
      : "No successful measured requests were recorded."
  };
}

function printSummary(summary, resultsDir) {
  console.log("");
  console.log("Top Worker placements:");
  for (const row of summary.ranked.slice(0, 10)) {
    console.log(
      `${String(row.rank).padStart(2)}. ${row.placement.padEnd(28)} ` +
      `p50=${formatMs(row.p50DbNetworkMs)} avg=${formatMs(row.avgDbNetworkMs)} p90=${formatMs(row.p90DbNetworkMs)} ` +
      `ok=${row.successCount}/${row.requestCount} ` +
      `worker=${formatCounts(row.workerColos)} d1=${formatCounts(row.d1Colos)}`
    );
  }
  console.log("");
  console.log(summary.recommendation);
  console.log(`Wrote ${path.join(resultsDir, "summary.json")}`);
  console.log(`Wrote ${path.join(resultsDir, "raw.json")}`);
}

async function buildAndOpenSite({ config, resultsDir }) {
  const inputPath = path.join(resultsDir, "raw.json");
  const args = [
    path.join(SCRIPT_DIR, "build-html-site.mjs"),
    "--input",
    inputPath,
    "--output",
    config.siteOutputPath,
    config.openSiteAfterRun ? "--open" : "--no-open"
  ];
  log(`Building finder report: ${config.siteOutputPath}.`);
  await runCommand(process.execPath, args);
  log(`Finished finder report: ${config.siteOutputPath}.`);
}

async function cleanupWorkers(workerNames, accountId) {
  for (const workerName of workerNames.slice().reverse()) {
    try {
      log(`Deleting Worker ${workerName}.`);
      await runWrangler(["delete", workerName, "--force"], {
        CLOUDFLARE_ACCOUNT_ID: accountId
      });
      await unregisterResource({ type: "worker", accountId, name: workerName });
    } catch (error) {
      if (!isAlreadyDeletedError(error)) {
        warn(`Could not delete Worker ${workerName}: ${error.message}`);
      } else {
        await unregisterResource({ type: "worker", accountId, name: workerName });
      }
    }
  }
}

async function persistRaw(resultsDir, raw) {
  await writeFile(path.join(resultsDir, "raw.partial.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

async function persistPartialIfNeeded(resultsDir, raw) {
  if (!raw || raw.run?.completedAt) return;
  try {
    await persistRaw(resultsDir, raw);
  } catch {
    // Best-effort partial result artifact.
  }
}

async function cfRequest(auth, route, init = {}) {
  const response = await fetch(`${API_BASE}${route}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeaders(auth),
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  const body = parseJsonBody(text);

  if (!response.ok || body.success === false) {
    const errors = Array.isArray(body.errors)
      ? body.errors.map((error) => error.message || JSON.stringify(error)).join("; ")
      : text;
    throw new Error(`Cloudflare API ${response.status} ${route}: ${errors}`);
  }

  return body;
}

async function runWrangler(args, envExtra) {
  const wrangler = await resolveWranglerInvocation();
  const env = {
    ...process.env,
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || path.resolve(ROOT_DIR, ".finder-tmp", "wrangler-logs"),
    ...envExtra
  };
  await mkdir(env.WRANGLER_LOG_PATH, { recursive: true });
  const output = await runCommand(wrangler.command, [...wrangler.prefixArgs, ...args], { env });
  return `${output.stdout}\n${output.stderr}`.trim();
}

async function resolveWranglerInvocation() {
  if (cachedWranglerInvocation) return cachedWranglerInvocation;

  try {
    await runCommand("wrangler", ["--version"], { silent: true });
    cachedWranglerInvocation = { command: "wrangler", prefixArgs: [] };
    return cachedWranglerInvocation;
  } catch (error) {
    if (error.code && error.code !== "ENOENT") throw error;
  }

  try {
    await runCommand("npx", ["--yes", "wrangler@latest", "--version"], { silent: true });
    cachedWranglerInvocation = { command: "npx", prefixArgs: ["--yes", "wrangler@latest"] };
    return cachedWranglerInvocation;
  } catch (error) {
    throw new Error(`Wrangler is required through "wrangler" or "npx --yes wrangler@latest": ${error.message}`);
  }
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!options.silent) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!options.silent) process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error(`${command} ${args.join(" ")} failed with exit code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function installTerminationHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      warn(`Received ${signal}; cleaning up temporary Workers.`);
      if (activeCleanup?.config.cleanupWorkers && activeCleanup.deployedWorkers.length > 0) {
        await cleanupWorkers(activeCleanup.deployedWorkers, activeCleanup.accountId);
      }
      process.exit(130);
    });
  }
}

function requirePlainObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${fieldName} must be an object.`);
}

function requireString(value, fieldName) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${fieldName} must be a non-empty string.`);
}

function requireBoolean(value, fieldName) {
  if (typeof value !== "boolean") throw new Error(`${fieldName} must be a boolean.`);
}

function requireArray(value, fieldName) {
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array.`);
}

function requirePositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${fieldName} must be a positive integer.`);
}

function validatePlacement(placement, fieldName) {
  if (typeof placement !== "string" || !/^[^:\s]+:[^:\s]+$/.test(placement)) {
    throw new Error(`Invalid ${fieldName} placement value: ${placement}`);
  }
}

function validateProviderRegionMap(map) {
  requirePlainObject(map, "d1-provider-region-map");
  const seen = new Set();
  for (const [d1Region, bucket] of Object.entries(map)) {
    requirePlainObject(bucket, `d1-provider-region-map.${d1Region}`);
    requireString(bucket.label, `d1-provider-region-map.${d1Region}.label`);
    requireArray(bucket.providerRegions, `d1-provider-region-map.${d1Region}.providerRegions`);
    if (bucket.providerRegions.length === 0) {
      throw new Error(`d1-provider-region-map.${d1Region}.providerRegions must not be empty.`);
    }
    for (const placement of bucket.providerRegions) {
      validatePlacement(placement, `d1-provider-region-map.${d1Region}.providerRegions`);
      if (seen.has(placement)) {
        throw new Error(`Duplicate Worker placement in D1 provider region map: ${placement}`);
      }
      seen.add(placement);
    }
  }
}

function parsePlacementHeader(value) {
  if (typeof value !== "string" || value.length === 0) return { placementMode: null, placementColo: null };
  const match = /^(local|remote)-([A-Z0-9]{3})$/i.exec(value.trim());
  if (!match) return { placementMode: null, placementColo: null };
  return { placementMode: match[1].toLowerCase(), placementColo: match[2].toUpperCase() };
}

function parseJsonBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { rawBody: text.slice(0, 1000) };
  }
}

function percentile(values, p) {
  const sorted = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return round(sorted[Math.max(0, Math.min(sorted.length - 1, index))], 3);
}

function average(values) {
  const valid = values.filter(isFiniteNumber);
  if (valid.length === 0) return null;
  return round(valid.reduce((sum, value) => sum + value, 0) / valid.length, 3);
}

function stddev(values) {
  const valid = values.filter(isFiniteNumber);
  if (valid.length < 2) return valid.length === 1 ? 0 : null;
  const avg = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  const variance = valid.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (valid.length - 1);
  return round(Math.sqrt(variance), 3);
}

function min(values) {
  const valid = values.filter(isFiniteNumber);
  return valid.length ? round(Math.min(...valid), 3) : null;
}

function max(values) {
  const valid = values.filter(isFiniteNumber);
  return valid.length ? round(Math.max(...valid), 3) : null;
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function compareNullable(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function countValues(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function mergeCounts(objects) {
  const merged = {};
  for (const object of objects) {
    if (!object || typeof object !== "object") continue;
    for (const [key, value] of Object.entries(object)) {
      merged[key] = (merged[key] || 0) + value;
    }
  }
  return merged;
}

function mostCommon(values) {
  const counts = countValues(values);
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function removeDeployedWorkers(deployedWorkers, workerNames) {
  for (const workerName of workerNames) {
    const index = deployedWorkers.indexOf(workerName);
    if (index >= 0) deployedWorkers.splice(index, 1);
  }
}

function makeWorkerName(prefix, runId, placement) {
  const hash = crypto.createHash("sha1").update(`${runId}:${placement}`).digest("hex").slice(0, 8);
  const suffix = sanitizeWorkerName(`${placement}-${hash}`);
  const maxPrefixLength = Math.max(1, MAX_WORKER_NAME_LENGTH - suffix.length - 1);
  return `${sanitizeWorkerName(prefix).slice(0, maxPrefixLength)}-${suffix}`.replace(/-+$/g, "");
}

function makeDatabaseKey(value) {
  return sanitizeWorkerName(String(value)) || "database";
}

function sanitizeWorkerName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function extractWorkersDevUrl(output) {
  const matches = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev[^\s]*/gi);
  if (!matches?.length) return undefined;
  return matches[matches.length - 1].replace(/[),.]+$/, "");
}

function isAlreadyDeletedError(error) {
  const text = `${error.message || ""}\n${error.stdout || ""}\n${error.stderr || ""}`.toLowerCase();
  return text.includes("does not exist") || text.includes("not found") || text.includes("could not find") || text.includes("code: 10090");
}

function toRunId(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function formatMs(value) {
  return isFiniteNumber(value) ? `${value.toFixed(2)}ms` : "n/a";
}

function formatCounts(counts) {
  const entries = Object.entries(counts || {});
  if (entries.length === 0) return "n/a";
  return entries.sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key}:${count}`).join(",");
}

function log(message) {
  console.log(`[finder] ${message}`);
}

function warn(message) {
  console.warn(`[finder] ${message}`);
}

function printHelp() {
  console.log(`
Usage:
  npm run finder -- --database-id <id>
  npm run finder -- --database-name <name>
  node ./src/find-worker-region.mjs --database-name <name>

Environment:
  CLOUDFLARE_API_TOKEN       Recommended Cloudflare API token.

Options:
  -c, --config <path>        JSON config file. Defaults to worker-region-finder.config.json.
      --database-id <id>     Existing D1 database ID.
      --database-name <name> Existing D1 database name.
      --help                 Show this help.
`);
}

main().catch((error) => {
  console.error("");
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
