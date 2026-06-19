#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanupTrackedResources, registerResource, unregisterResource } from "./clean-resources.mjs";

const VALID_D1_JURISDICTIONS = new Set(["eu", "fedramp"]);
const API_BASE = "https://api.cloudflare.com/client/v4";
const DATA_DIR = "data";
const D1_LOCATIONS_FILE = "d1-locations.json";
const DEFAULT_CONFIG_PATH = "benchmark.config.json";
let cachedWranglerInvocation;
let activeRunContext;
let terminationCleanupStarted = false;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const startedAt = new Date();
  const rootDir = process.cwd();
  const config = await loadConfig(args.config, rootDir);
  const benchmarkData = await loadBenchmarkData(rootDir);
  validateConfig(config, benchmarkData);
  const d1Locations = getConfiguredD1Locations(config, benchmarkData.d1Locations);
  const workerPlacementsByD1Location = resolveWorkerPlacementMatrix(config, d1Locations, benchmarkData.workerPlacements);
  const candidatePlacements = unique(Object.values(workerPlacementsByD1Location).flat());
  validateWorkerPlacementMatrix(workerPlacementsByD1Location);

  const auth = readAuthFromEnv();
  const accountId = await resolveAccountId(auth, config.accountId);
  const runId = toRunId(startedAt);
  activeRunContext = { accountId, runId };
  installTerminationHandlers();
  const tempDir = path.resolve(rootDir, ".benchmark-tmp", runId);
  const resultsDir = path.resolve(rootDir, config.resultsDir);
  const deployedWorkers = [];
  let databases = [];
  let rawResult = undefined;

  console.log("D1 exact provider-region pinning is not exposed by Cloudflare.");
  console.log("This benchmark tests Worker targeted placement against the observed D1 region.");
  console.log("");
  console.log(`Account: ${accountId}`);
  console.log(`Run: ${runId}`);

  await mkdir(tempDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });

  try {
    databases = await prepareDatabases({ auth, accountId, config, runId, d1Locations });
    for (const database of databases) {
      console.log(
        `D1 database: ${database.name} (${database.id}), target=${database.targetLocation ?? "unknown"}, observed=${database.observedRegion ?? "unknown"}`
      );
    }

    const workerSourcePath = await copyWorkerSource(rootDir, tempDir);

    rawResult = {
      run: {
        id: runId,
        startedAt: startedAt.toISOString(),
        completedAt: undefined,
        config: redactConfig(config),
        accountId,
        d1Locations,
        workerPlacementsByD1Location,
        warnings: [
          "D1 exact provider-region pinning is not exposed. Creation location is a hint unless a supported jurisdiction is used."
        ]
      },
      databases: databases.map(serializeDatabase),
      workerPlacements: candidatePlacements,
      batches: [],
      warmup: {},
      measured: {}
    };

    const placementBatches = chunk(candidatePlacements, config.maxWorkersPerBatch);
    for (let batchIndex = 0; batchIndex < placementBatches.length; batchIndex += 1) {
      const placements = placementBatches[batchIndex];
      const batchWorkers = [];
      console.log(`Deploying Worker batch ${batchIndex + 1}/${placementBatches.length} (${placements.length} Workers)...`);

      try {
        const workers = await deployWorkers({
          accountId,
          config,
          databases,
          placements,
          batchIndex,
          runId,
          tempDir,
          workerSourcePath,
          deployedWorkers
        });
        batchWorkers.push(...workers);
        rawResult.batches.push({ index: batchIndex, placements, workers });
        await persistProgress(resultsDir, rawResult);

        if (config.propagationSeconds > 0) {
          console.log(`Waiting ${config.propagationSeconds}s for Worker propagation...`);
          await sleep(config.propagationSeconds * 1000);
        }

        for (const database of databases) {
          const placementsForDatabase = new Set(workerPlacementsByD1Location[database.targetLocation] || []);
          ensureResultBucket(rawResult.warmup, database.key);
          ensureResultBucket(rawResult.measured, database.key);

          for (const worker of workers) {
            if (!placementsForDatabase.has(worker.placement)) continue;
            console.log(`Warmup: D1 ${database.label} x Worker ${worker.placement}`);
            rawResult.warmup[database.key][worker.placement] = await runRequests({
              worker,
              database,
              requests: config.benchmark.warmupRequests,
              queriesPerRequest: config.benchmark.queriesPerRequest,
              concurrency: config.benchmark.concurrency,
              timeoutMs: config.benchmark.requestTimeoutMs
            });
            await persistProgress(resultsDir, rawResult);

            console.log(`Measured: D1 ${database.label} x Worker ${worker.placement}`);
            rawResult.measured[database.key][worker.placement] = await runRequests({
              worker,
              database,
              requests: config.benchmark.measuredRequests,
              queriesPerRequest: config.benchmark.queriesPerRequest,
              concurrency: config.benchmark.concurrency,
              timeoutMs: config.benchmark.requestTimeoutMs
            });
            await persistProgress(resultsDir, rawResult);
          }
        }
      } finally {
        if (config.cleanupWorkers) {
          await cleanupWorkers(batchWorkers.map((worker) => worker.name), accountId);
          removeDeployedWorkers(deployedWorkers, batchWorkers.map((worker) => worker.name));
        }
      }
    }

    rawResult.run.completedAt = new Date().toISOString();
    await writeOutputs(resultsDir, rawResult);
    await buildAndOpenSite({ config, resultsDir, rootDir });
    const summary = buildSummary(rawResult);
    printSummary(summary, resultsDir);
  } finally {
    await writePartialIfNeeded(resultsDir, rawResult);
    if (config.cleanupWorkers && deployedWorkers.length > 0) {
      await cleanupWorkers(deployedWorkers, accountId);
    } else if (deployedWorkers.length > 0) {
      console.log(`Keeping ${deployedWorkers.length} benchmark Workers because cleanupWorkers=false.`);
    }

    for (const database of databases) {
      const shouldDeleteDatabase =
        database.created &&
        config.deleteD1DatabasesAfterRun !== false;

      if (shouldDeleteDatabase) {
        await cleanupDatabase(database.name, accountId);
      } else if (database.created) {
        console.log(`Keeping disposable D1 database ${database.name}.`);
      }
    }

    if (config.cleanupWorkers && config.deleteD1DatabasesAfterRun !== false) {
      await cleanupRegisteredResources({ accountId, runId });
    }
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--config" || arg === "-c") args.config = requireValue(argv, ++i, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function installTerminationHandlers() {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      void handleTermination(signal);
    });
  }

  process.once("uncaughtException", (error) => {
    console.error(error.stack || error.message);
    void handleTermination("uncaughtException");
  });

  process.once("unhandledRejection", (reason) => {
    console.error(reason instanceof Error ? reason.stack || reason.message : reason);
    void handleTermination("unhandledRejection");
  });
}

async function handleTermination(reason) {
  if (terminationCleanupStarted) return;
  terminationCleanupStarted = true;

  console.warn(`Benchmark interrupted by ${reason}; attempting cleanup for current run...`);
  if (activeRunContext) {
    try {
      await cleanupRegisteredResources(activeRunContext);
    } catch (error) {
      console.warn(`Automatic cleanup did not complete: ${error.message}`);
    }
  }

  process.exitCode = 1;
  process.exit();
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage:
  npm run benchmark
  npm run benchmark -- --config benchmark.config.partial.json

Default behavior:
  Loads benchmark.config.json, creates D1 databases from data/d1-locations.json, expands Worker
  placements from data/*-regions.json, deploys Workers in batches of up to maxWorkersPerBatch,
  and tests every selected D1 x Worker placement pair.

Environment:
  CLOUDFLARE_API_TOKEN       Recommended Cloudflare API token.
  CLOUDFLARE_ACCOUNT_ID      Optional account ID when the token has multiple accounts.

Options:
  -c, --config <path>        JSON config file. Defaults to benchmark.config.json.
      --help                 Show this help.

Progress files:
  results/raw.partial.json
`);
}

async function loadConfig(configPath, rootDir) {
  const selectedConfigPath = configPath || DEFAULT_CONFIG_PATH;
  const absolutePath = path.resolve(rootDir, selectedConfigPath);
  const file = await readFile(absolutePath, "utf8");
  return JSON.parse(file);
}

async function loadBenchmarkData(rootDir) {
  const dataDir = path.resolve(rootDir, DATA_DIR);
  const d1Data = JSON.parse(await readFile(path.join(dataDir, D1_LOCATIONS_FILE), "utf8"));
  if (
    !Array.isArray(d1Data.locations) ||
    d1Data.locations.length === 0 ||
    d1Data.locations.some((location) => typeof location !== "string" || !location)
  ) {
    throw new Error(`${path.join(DATA_DIR, D1_LOCATIONS_FILE)} must contain a non-empty string locations array.`);
  }

  const regionFiles = (await readdir(dataDir))
    .filter((fileName) => fileName.endsWith("-regions.json"))
    .sort();
  if (regionFiles.length === 0) {
    throw new Error(`${DATA_DIR} must contain at least one *-regions.json file.`);
  }

  const providers = new Set();
  const workerPlacements = [];
  for (const fileName of regionFiles) {
    const relativePath = path.join(DATA_DIR, fileName);
    const regionData = JSON.parse(await readFile(path.join(dataDir, fileName), "utf8"));
    if (typeof regionData.provider !== "string" || regionData.provider.length === 0) {
      throw new Error(`${relativePath} must contain a non-empty provider string.`);
    }
    if (providers.has(regionData.provider)) {
      throw new Error(`${relativePath} declares duplicate provider ${regionData.provider}.`);
    }
    providers.add(regionData.provider);
    if (
      !Array.isArray(regionData.regions) ||
      regionData.regions.length === 0 ||
      regionData.regions.some((region) => typeof region !== "string" || !region)
    ) {
      throw new Error(`${relativePath} must contain a non-empty string regions array.`);
    }
    workerPlacements.push(...regionData.regions.map((region) => `${regionData.provider}:${region}`));
  }

  return {
    d1Locations: unique(d1Data.locations),
    workerPlacements: unique(workerPlacements)
  };
}

function validateConfig(config, benchmarkData) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Config must be a JSON object.");
  }
  if ("regionFiles" in config) {
    throw new Error("regionFiles was removed. Add provider fields to data/*-regions.json instead.");
  }
  if ("candidateProviders" in config) {
    throw new Error("candidateProviders was removed. All data/*-regions.json files are used by default.");
  }
  requireString(config.d1DatabaseNamePrefix, "d1DatabaseNamePrefix");
  requireBoolean(config.deleteD1DatabasesAfterRun, "deleteD1DatabasesAfterRun");
  if ("database" in config) {
    requirePlainObject(config.database, "database");
  }
  const databaseConfig = config.database || {};
  if ("location" in databaseConfig) {
    requireString(databaseConfig.location, "database.location");
  }
  if (databaseConfig.jurisdiction && !VALID_D1_JURISDICTIONS.has(databaseConfig.jurisdiction)) {
    throw new Error(`database.jurisdiction must be one of: ${[...VALID_D1_JURISDICTIONS].join(", ")}`);
  }
  const validD1Locations = new Set(benchmarkData.d1Locations);
  if (databaseConfig.location && !validD1Locations.has(databaseConfig.location)) {
    throw new Error(`database.location must be one of: ${benchmarkData.d1Locations.join(", ")}`);
  }
  if ("locations" in databaseConfig) {
    if (!Array.isArray(databaseConfig.locations) || databaseConfig.locations.length === 0) {
      throw new Error("database.locations must contain at least one D1 location when provided.");
    }
  }
  const locations = getConfiguredD1Locations(config, benchmarkData.d1Locations);
  if (locations.length === 0) {
    throw new Error("At least one D1 location is required in data/d1-locations.json, database.location, database.locations, or workerPlacementsByD1Location.");
  }
  for (const location of locations) {
    if (!validD1Locations.has(location)) {
      throw new Error(`database.locations contains unsupported D1 location hint: ${location}`);
    }
  }
  if ("candidatePlacements" in config) {
    if (!Array.isArray(config.candidatePlacements) || config.candidatePlacements.length === 0) {
      throw new Error("candidatePlacements must contain at least one placement region when provided.");
    }
    for (const placement of config.candidatePlacements) {
      validatePlacement(placement, "candidatePlacements");
    }
  }
  if ("workerPlacementsByD1Location" in config) {
    if ("candidatePlacements" in config) {
      throw new Error("Use either candidatePlacements or workerPlacementsByD1Location, not both.");
    }
    requirePlainObject(config.workerPlacementsByD1Location, "workerPlacementsByD1Location");
    for (const [location, placements] of Object.entries(config.workerPlacementsByD1Location)) {
      if (!validD1Locations.has(location)) {
        throw new Error(`workerPlacementsByD1Location contains unsupported D1 location hint: ${location}`);
      }
      if (!Array.isArray(placements) || placements.length === 0) {
        throw new Error(`workerPlacementsByD1Location.${location} must contain at least one placement region.`);
      }
      for (const placement of placements) {
        validatePlacement(placement, `workerPlacementsByD1Location.${location}`);
      }
    }
  }
  requireString(config.workerNamePrefix, "workerNamePrefix");
  requireString(config.workerCompatibilityDate, "workerCompatibilityDate");
  if (!Array.isArray(config.workerCompatibilityFlags)) {
    throw new Error("workerCompatibilityFlags must be an array.");
  }
  for (const flag of config.workerCompatibilityFlags) {
    requireString(flag, "workerCompatibilityFlags[]");
  }
  requireBoolean(config.workerObservabilityEnabled, "workerObservabilityEnabled");
  if (!Number.isInteger(config.maxWorkersPerBatch) || config.maxWorkersPerBatch < 1) {
    throw new Error("maxWorkersPerBatch must be a positive integer.");
  }
  requirePlainObject(config.benchmark, "benchmark");
  for (const key of ["warmupRequests", "measuredRequests", "queriesPerRequest", "concurrency", "requestTimeoutMs"]) {
    if (!Number.isInteger(config.benchmark[key]) || config.benchmark[key] < 1) {
      throw new Error(`benchmark.${key} must be a positive integer.`);
    }
  }
  requireBoolean(config.cleanupWorkers, "cleanupWorkers");
  if (!Number.isInteger(config.propagationSeconds) || config.propagationSeconds < 0) {
    throw new Error("propagationSeconds must be a non-negative integer.");
  }
  requireString(config.resultsDir, "resultsDir");
  requireString(config.siteOutputPath, "siteOutputPath");
  requireBoolean(config.openSiteAfterRun, "openSiteAfterRun");
}

function resolveWorkerPlacementMatrix(config, d1Locations, dataWorkerPlacements) {
  if (config.workerPlacementsByD1Location) {
    return Object.fromEntries(
      d1Locations.map((location) => {
        const placements = config.workerPlacementsByD1Location[location];
        if (!placements) {
          throw new Error(`workerPlacementsByD1Location must include ${location} because it is selected as a D1 location.`);
        }
        return [location, unique(placements)];
      })
    );
  }

  const placements = config.candidatePlacements ? unique(config.candidatePlacements) : dataWorkerPlacements;
  return Object.fromEntries(d1Locations.map((location) => [location, placements]));
}

function validateWorkerPlacementMatrix(workerPlacementsByD1Location) {
  const placements = Object.values(workerPlacementsByD1Location).flat();
  if (placements.length === 0) {
    throw new Error("At least one Worker placement is required.");
  }
  for (const placement of placements) {
    validatePlacement(placement, "worker placement");
  }
}

function getConfiguredD1Locations(config, dataD1Locations) {
  const databaseConfig = config.database || {};
  if (databaseConfig.location) return [databaseConfig.location];
  if (Array.isArray(databaseConfig.locations) && databaseConfig.locations.length > 0) {
    return unique(databaseConfig.locations);
  }
  if (config.workerPlacementsByD1Location) {
    return Object.keys(config.workerPlacementsByD1Location);
  }
  return dataD1Locations;
}

function validatePlacement(placement, fieldName) {
  if (typeof placement !== "string" || !/^[^:\s]+:[^:\s]+$/.test(placement)) {
    throw new Error(`Invalid ${fieldName} placement value: ${placement}`);
  }
}

function requirePlainObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }
}

function requireString(value, fieldName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
}

function requireBoolean(value, fieldName) {
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean.`);
  }
}

function readAuthFromEnv() {
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  const globalKey = process.env.CLOUDFLARE_API_KEY || process.env.CF_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL || process.env.CF_EMAIL;
  if (token) return { mode: "token", token };
  if (globalKey && email) return { mode: "global-key", globalKey, email };

  throw new Error(
    "Set CLOUDFLARE_API_TOKEN. Legacy global key auth requires both CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL."
  );
}

function authHeaders(auth) {
  if (auth.mode === "token") {
    return { Authorization: `Bearer ${auth.token}` };
  }
  return {
    "X-Auth-Email": auth.email,
    "X-Auth-Key": auth.globalKey
  };
}

function wranglerEnv(extra = {}) {
  return {
    ...process.env,
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || path.resolve(process.cwd(), ".benchmark-tmp", "wrangler-logs"),
    ...extra
  };
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

async function prepareDatabases({ auth, accountId, config, runId, d1Locations }) {
  const locations = d1Locations;
  const namePrefix = config.d1DatabaseNamePrefix;
  const databaseConfig = config.database || {};
  const databases = [];

  console.log(`Creating ${locations.length} disposable D1 databases before Worker tests...`);
  for (const location of locations) {
    const name = `${namePrefix}-${location}-${Date.now()}`;
    const createdDatabase = await createD1Database(name, { ...databaseConfig, location, jurisdiction: undefined }, accountId);
    await registerResource({
      type: "d1",
      accountId,
      runId,
      name,
      id: createdDatabase.id,
      metadata: { targetLocation: location }
    });
    const database = await prepareOneDatabase({
      auth,
      accountId,
      databaseConfig: createdDatabase.id ? { id: createdDatabase.id, name } : { name },
      created: true,
      targetLocation: location,
      label: location
    });
    databases.push(database);
  }

  return databases;
}

async function prepareOneDatabase({ auth, accountId, databaseConfig, created, targetLocation, label }) {
  const database = await findDatabase(auth, accountId, databaseConfig);
  await seedDatabase(database.name, accountId);
  const observed = await observeD1Region(auth, accountId, database.id);
  const info = await getDatabaseInfo(auth, accountId, database.id).catch(() => undefined);
  const observedRegion = observed?.servedByRegion ?? info?.running_in_region ?? info?.primary_location_hint;

  return {
    key: makeDatabaseKey(label || database.name),
    label: label || database.name,
    id: database.id,
    name: database.name,
    created,
    targetLocation,
    jurisdiction: database.jurisdiction ?? info?.jurisdiction,
    observedRegion,
    bindingName: makeBindingName(label || database.name),
    rawInfo: info,
    seedMeta: observed
  };
}

async function findDatabase(auth, accountId, databaseConfig) {
  if (databaseConfig.id) {
    const info = await getDatabaseInfo(auth, accountId, databaseConfig.id);
    return normalizeDatabase(info);
  }

  const databases = await listDatabases(auth, accountId);
  const matches = databases.filter((database) => database.name === databaseConfig.name);
  if (matches.length === 0) {
    throw new Error(`D1 database not found by name: ${databaseConfig.name}`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple D1 databases matched name ${databaseConfig.name}; use database.id.`);
  }
  return matches[0];
}

async function listDatabases(auth, accountId) {
  const databases = [];
  let page = 1;

  while (true) {
    const response = await cfRequest(auth, `/accounts/${accountId}/d1/database?per_page=100&page=${page}`);
    const pageDatabases = Array.isArray(response.result) ? response.result.map(normalizeDatabase) : [];
    databases.push(...pageDatabases);

    const resultInfo = response.result_info;
    const totalPages = Number(resultInfo?.total_pages);
    const count = Number(resultInfo?.count);
    if (Number.isFinite(totalPages) && totalPages > 0) {
      if (page >= totalPages) break;
    } else if (Number.isFinite(count)) {
      if (count < 100) break;
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

async function getDatabaseInfo(auth, accountId, databaseId) {
  const response = await cfRequest(auth, `/accounts/${accountId}/d1/database/${databaseId}`);
  return response.result;
}

async function createD1Database(name, databaseConfig, accountId) {
  console.log(`Creating disposable D1 database: ${name}`);
  const args = ["d1", "create", name];
  if (databaseConfig.jurisdiction) {
    args.push("--jurisdiction", databaseConfig.jurisdiction);
  } else if (databaseConfig.location) {
    args.push("--location", databaseConfig.location);
  }
  const output = await runWrangler(args, { CLOUDFLARE_ACCOUNT_ID: accountId });
  return {
    name,
    id: extractD1DatabaseId(output),
    rawOutput: output
  };
}

async function seedDatabase(databaseName, accountId) {
  console.log("Creating and seeding benchmark table...");
  const sql = [
    "CREATE TABLE IF NOT EXISTS bench_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);",
    "DELETE FROM bench_items;",
    ...Array.from({ length: 100 }, (_, index) => {
      const id = index + 1;
      return `INSERT INTO bench_items (id, value) VALUES (${id}, 'item-${id}');`;
    })
  ].join(" ");

  await runWrangler(["d1", "execute", databaseName, "--remote", "--command", sql, "--yes"], {
    CLOUDFLARE_ACCOUNT_ID: accountId
  });
}

async function observeD1Region(auth, accountId, databaseId) {
  try {
    const response = await cfRequest(auth, `/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT 1 AS ok;" })
    });
    const result = Array.isArray(response.result) ? response.result[0] : response.result;
    const meta = result?.meta ?? response.result?.meta;
    return {
      servedByRegion: meta?.served_by_region,
      servedByColo: meta?.served_by_colo,
      sqlDurationMs: meta?.timings?.sql_duration_ms ?? meta?.duration,
      rawMeta: meta
    };
  } catch (error) {
    console.warn(`Could not observe D1 region through the query API: ${error.message}`);
    return undefined;
  }
}

async function deployWorkers({ accountId, config, databases, placements, batchIndex, runId, tempDir, workerSourcePath, deployedWorkers }) {
  const workers = [];

  for (const placement of placements) {
    const workerName = sanitizeWorkerName(`${config.workerNamePrefix}-b${batchIndex + 1}-${placement}`);
    const workerDir = path.join(tempDir, workerName);
    const configPath = path.join(workerDir, "wrangler.json");
    await mkdir(workerDir, { recursive: true });

    const wranglerConfig = {
      $schema: "https://unpkg.com/wrangler/config-schema.json",
      account_id: accountId,
      name: workerName,
      main: path.relative(workerDir, workerSourcePath),
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
        QUERIES_PER_REQUEST: String(config.benchmark.queriesPerRequest),
        DATABASE_BINDINGS: JSON.stringify(
          Object.fromEntries(databases.map((database) => [database.key, database.bindingName]))
        )
      },
      d1_databases: databases.map((database) => ({
        binding: database.bindingName,
        database_name: database.name,
        database_id: database.id
      }))
    };

    await writeFile(configPath, `${JSON.stringify(wranglerConfig, null, 2)}\n`, "utf8");

    console.log(`Deploying ${workerName} (${placement})...`);
    const deployOutput = await runWrangler(["deploy", "--config", configPath, "--minify"], {
      CLOUDFLARE_ACCOUNT_ID: accountId
    });
    deployedWorkers.push(workerName);
    const url = extractWorkersDevUrl(deployOutput);
    if (!url) {
      throw new Error(`Could not find workers.dev URL in Wrangler deploy output for ${workerName}.`);
    }
    await registerResource({
      type: "worker",
      accountId,
      runId,
      name: workerName,
      url,
      metadata: { placement, batchIndex }
    });
    workers.push({ name: workerName, placement, url, configPath });
  }

  return workers;
}

async function copyWorkerSource(rootDir, tempDir) {
  const sourcePath = path.join(rootDir, "src", "benchmark-worker-source.mjs");
  const targetPath = path.join(tempDir, "benchmark-worker-source.mjs");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(targetPath, source, "utf8");
  return targetPath;
}

async function runRequests({ worker, database, requests, queriesPerRequest, concurrency, timeoutMs }) {
  const tasks = Array.from({ length: requests }, (_, index) => index);
  const results = [];
  let next = 0;

  async function runNext() {
    while (next < tasks.length) {
      const requestIndex = next;
      next += 1;
      results[requestIndex] = await callBench(worker, database, queriesPerRequest, timeoutMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, runNext));
  return results;
}

async function callBench(worker, database, queriesPerRequest, timeoutMs) {
  const url = new URL("/bench", worker.url);
  url.searchParams.set("queries", String(queriesPerRequest));
  url.searchParams.set("db", database.key);

  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const clientMs = performance.now() - started;
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { rawBody: text.slice(0, 1000) };
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        clientMs,
        error: body?.error || `HTTP ${response.status}`,
        body
      };
    }

    return {
      ok: true,
      status: response.status,
      clientMs,
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

function buildSummary(raw) {
  const databases = (raw.databases || [raw.database]).filter(Boolean);
  const byDatabase = {};
  const allRanked = [];

  for (const database of databases) {
    const measured = raw.measured?.[database.key] || {};
    const placements = Object.entries(measured).map(([placement, requests]) =>
      summarizePlacement({ raw, database, placement, requests })
    );
    const ranked = placements
      .slice()
      .sort((a, b) => compareNullable(a.p95DbMs, b.p95DbMs) || compareNullable(a.avgDbMs, b.avgDbMs))
      .map((item, index) => ({ rank: index + 1, ...item }));

    byDatabase[database.key] = {
      database,
      placements,
      ranked,
      recommendation: ranked.find((item) => item.successCount > 0)
        ? `Use ${ranked.find((item) => item.successCount > 0).placement} for D1 ${database.label} based on the lowest p95 latency in this run.`
        : `No successful benchmark requests were recorded for D1 ${database.label}.`
    };
    allRanked.push(...ranked.map((item) => ({ ...item, databaseKey: database.key, databaseLabel: database.label })));
  }

  const best = allRanked
    .filter((item) => item.successCount > 0)
    .sort((a, b) => compareNullable(a.p95DbMs, b.p95DbMs) || compareNullable(a.avgDbMs, b.avgDbMs))[0];

  return {
    run: raw.run,
    databases,
    byDatabase,
    ranked: allRanked,
    recommendation: best
      ? `Best observed pair: D1 ${best.databaseLabel} x Worker ${best.placement} based on the lowest p95 latency in this run.`
      : "No successful benchmark requests were recorded."
  };
}

function summarizePlacement({ raw, database, placement, requests }) {
  const successes = requests.filter((request) => request.ok);
  const errors = requests.filter((request) => !request.ok);
  const serverTimes = successes.map((request) => adjustedTotalMs(request.body)).filter(isFiniteNumber);
  const rawServerTimes = successes.map((request) => request.body?.totalMs).filter(isFiniteNumber);
  const perQueryTimes = successes.flatMap((request) => adjustedPerQueryMs(request.body)).filter(isFiniteNumber);
  const rawPerQueryTimes = successes.flatMap((request) => request.body?.perQueryMs ?? []).filter(isFiniteNumber);
  const sqlDurations = successes.flatMap((request) => request.body?.d1?.sqlDurations ?? []).filter(isFiniteNumber);
  const workerColos = countValues(successes.map((request) => request.body?.workerColo).filter(Boolean));
  const d1Regions = mergeCounts(successes.map((request) => request.body?.d1?.regions));
  const d1Colos = mergeCounts(successes.map((request) => request.body?.d1?.colos));
  const worker = findWorker(raw, placement);

  return {
    databaseKey: database.key,
    databaseLabel: database.label,
    databaseName: database.name,
    d1TargetLocation: database.targetLocation,
    d1ObservedRegion: database.observedRegion,
    placement,
    workerName: worker?.name,
    url: worker?.url,
    requestCount: requests.length,
    successCount: successes.length,
    errorCount: errors.length,
    errors: summarizeErrors(errors),
    avgDbMs: average(serverTimes),
    p50DbMs: percentile(serverTimes, 50),
    p90DbMs: percentile(serverTimes, 90),
    p95DbMs: percentile(serverTimes, 95),
    p99DbMs: percentile(serverTimes, 99),
    minDbMs: min(serverTimes),
    maxDbMs: max(serverTimes),
    stddevDbMs: stddev(serverTimes),
    avgPerQueryMs: average(perQueryTimes),
    avgRawDbMs: average(rawServerTimes),
    avgRawPerQueryMs: average(rawPerQueryTimes),
    avgD1SqlDurationMs: average(sqlDurations),
    workerColos,
    d1Regions,
    d1Colos
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

function findWorker(raw, placement) {
  for (const batch of raw.batches || []) {
    const worker = batch.workers?.find((candidate) => candidate.placement === placement);
    if (worker) return worker;
  }
  return undefined;
}

function summarizeErrors(errors) {
  return countValues(errors.map((error) => error.error || `HTTP ${error.status}`));
}

function ensureResultBucket(object, key) {
  if (!object[key]) object[key] = {};
}

function serializeDatabase(database) {
  return {
    key: database.key,
    label: database.label,
    id: database.id,
    name: database.name,
    createdByBenchmark: database.created,
    targetLocation: database.targetLocation,
    observedRegion: database.observedRegion,
    jurisdiction: database.jurisdiction,
    bindingName: database.bindingName,
    rawInfo: database.rawInfo
  };
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function unique(values) {
  return [...new Set(values)];
}

function makeDatabaseKey(value) {
  return sanitizeWorkerName(String(value)) || "database";
}

function makeBindingName(value) {
  return `DB_${String(value).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "DATABASE"}`;
}

function removeDeployedWorkers(deployedWorkers, workerNames) {
  for (const workerName of workerNames) {
    const index = deployedWorkers.indexOf(workerName);
    if (index >= 0) deployedWorkers.splice(index, 1);
  }
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

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

async function writeOutputs(resultsDir, raw) {
  await writeFile(path.join(resultsDir, "raw.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  await rm(path.join(resultsDir, "raw.partial.json"), { force: true });
}

async function buildAndOpenSite({ config, resultsDir, rootDir }) {
  const inputPath = path.join(resultsDir, "raw.json");
  const args = [
    path.join(rootDir, "src", "build-html-site.mjs"),
    "--input",
    inputPath,
    "--output",
    config.siteOutputPath,
    config.openSiteAfterRun ? "--open" : "--no-open"
  ];
  console.log(`Building benchmark report: ${config.siteOutputPath}`);
  await runCommand(process.execPath, args);
}

async function persistProgress(resultsDir, raw) {
  await writeFile(path.join(resultsDir, "raw.partial.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

async function writePartialIfNeeded(resultsDir, raw) {
  if (!raw) return;
  if (raw.run?.completedAt) return;
  try {
    await persistProgress(resultsDir, raw);
  } catch {
    // Best-effort failure artifact only.
  }
}

function printSummary(summary, resultsDir) {
  console.log("");
  console.log("Top ranking per D1 database:");
  for (const entry of Object.values(summary.byDatabase)) {
    const row = entry.ranked.find((item) => item.successCount > 0);
    if (row) {
      console.log(
        `${entry.database.label}: ${row.placement} p95=${formatMs(row.p95DbMs)} avg=${formatMs(row.avgDbMs)} errors=${row.errorCount}`
      );
    } else {
      console.log(`${entry.database.label}: no successful requests`);
    }
  }
  console.log("");
  console.log(summary.recommendation);
  console.log(`Wrote ${path.join(resultsDir, "raw.json")}`);
}

function formatMs(value) {
  return isFiniteNumber(value) ? `${value.toFixed(2)}ms` : "n/a";
}

async function cleanupWorkers(workerNames, accountId) {
  for (const workerName of workerNames.slice().reverse()) {
    try {
      console.log(`Deleting Worker ${workerName}...`);
      await runWrangler(["delete", workerName, "--force"], {
        CLOUDFLARE_ACCOUNT_ID: accountId
      });
      await unregisterResource({ type: "worker", accountId, name: workerName });
    } catch (error) {
      if (isAlreadyDeletedError(error)) {
        await unregisterResource({ type: "worker", accountId, name: workerName });
      } else {
        console.warn(`Could not delete Worker ${workerName}: ${error.message}`);
      }
    }
  }
}

async function cleanupDatabase(databaseName, accountId) {
  try {
    console.log(`Deleting disposable D1 database ${databaseName}...`);
    await runWrangler(["d1", "delete", databaseName, "--skip-confirmation"], {
      CLOUDFLARE_ACCOUNT_ID: accountId
    });
    await unregisterResource({ type: "d1", accountId, name: databaseName });
  } catch (error) {
    if (isAlreadyDeletedError(error)) {
      await unregisterResource({ type: "d1", accountId, name: databaseName });
    } else {
      console.warn(`Could not delete D1 database ${databaseName}: ${error.message}`);
    }
  }
}

async function cleanupRegisteredResources({ accountId, runId }) {
  await cleanupTrackedResources({ accountId, runId });
}

function isAlreadyDeletedError(error) {
  const text = `${error.message || ""}\n${error.stdout || ""}\n${error.stderr || ""}`.toLowerCase();
  return (
    text.includes("does not exist") ||
    text.includes("not found") ||
    text.includes("could not find") ||
    text.includes("code: 10090")
  );
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
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

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
  const env = wranglerEnv(envExtra);
  if (env.WRANGLER_LOG_PATH) {
    await mkdir(env.WRANGLER_LOG_PATH, { recursive: true });
  }
  const output = await runCommand(wrangler.command, [...wrangler.prefixArgs, ...args], {
    env
  });
  return `${output.stdout}\n${output.stderr}`.trim();
}

async function resolveWranglerInvocation() {
  if (cachedWranglerInvocation) return cachedWranglerInvocation;

  try {
    await runCommand("wrangler", ["--version"], { silent: true });
    cachedWranglerInvocation = { command: "wrangler", prefixArgs: [] };
    return cachedWranglerInvocation;
  } catch (error) {
    if (error.code && error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await runCommand("npx", ["--yes", "wrangler@latest", "--version"], { silent: true });
    cachedWranglerInvocation = { command: "npx", prefixArgs: ["--yes", "wrangler@latest"] };
    return cachedWranglerInvocation;
  } catch (error) {
    throw new Error(
      `Wrangler is required but was not available through "wrangler" or "npx --yes wrangler@latest": ${error.message}`
    );
  }
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
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
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const message = `${command} ${args.join(" ")} failed with exit code ${code}`;
        const error = new Error(message);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function extractWorkersDevUrl(output) {
  const matches = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev[^\s]*/gi);
  if (!matches?.length) return undefined;
  return matches[matches.length - 1].replace(/[),.]+$/, "");
}

function extractD1DatabaseId(output) {
  const jsonStyleMatch = output.match(/"database_id"\s*:\s*"([^"]+)"/);
  if (jsonStyleMatch) return jsonStyleMatch[1];

  const uuidMatch = output.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  return uuidMatch?.[0];
}

function sanitizeWorkerName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function toRunId(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function redactConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

main().catch((error) => {
  console.error("");
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
