#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanupTrackedResources, registerResource, unregisterResource } from "./clean-resources.mjs";
import {
  getMinSuccessfulRequests,
  getPairMeasurements,
  isPairReliable,
  parsePlacementHeader
} from "./placement-eligibility.mjs";

const require = createRequire(import.meta.url);
const { DEFAULT_AGGREGATE_METRIC } = require("./metric-stats.cjs");
const VALID_D1_JURISDICTIONS = new Set(["eu", "fedramp"]);
const API_BASE = "https://api.cloudflare.com/client/v4";
const DATA_DIR = "data";
const D1_LOCATIONS_FILE = "d1-locations.json";
const DEFAULT_CONFIG_PATH = "benchmark.config.json";
const DEFAULT_AGGREGATE_FIELD = `${DEFAULT_AGGREGATE_METRIC}DbMs`;
const WORKER_DEPLOY_RETRY_ATTEMPTS = 4;
const WORKER_DEPLOY_RETRY_DELAY_MS = 5000;
let cachedWranglerInvocation;
let activeRunContext;
let terminationCleanupStarted = false;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const rootDir = process.cwd();
  const resume = args.resume ? await loadResumeRun(args.resume, rootDir) : null;
  const startedAt = resume ? new Date(resume.raw.run?.startedAt || Date.now()) : new Date();
  const config = resume ? resume.raw.run?.config : await loadConfig(args.config, rootDir);
  const benchmarkData = await loadBenchmarkData(rootDir);
  validateConfig(config, benchmarkData);
  const d1Locations = getConfiguredD1Locations(config, benchmarkData.d1Locations);
  const workerPlacementsByD1Location = resolveWorkerPlacementMatrix(config, d1Locations, benchmarkData.workerPlacements);
  const candidatePlacements = unique(Object.values(workerPlacementsByD1Location).flat());
  validateWorkerPlacementMatrix(workerPlacementsByD1Location);
  const placementBatches = chunk(candidatePlacements, config.maxWorkersPerBatch);
  const progress = createBenchmarkProgress({
    config,
    d1Locations,
    workerPlacementsByD1Location,
    candidatePlacements,
    placementBatches
  });

  const auth = readAuthFromEnv();
  const accountId = resume?.raw.run?.accountId || await resolveAccountId(auth, config.accountId);
  const runId = resume?.raw.run?.id || toRunId(startedAt);
  activeRunContext = { accountId, runId };
  installTerminationHandlers();
  const tempDir = path.resolve(rootDir, ".benchmark-tmp", runId);
  const resultsDir = resume ? resume.resultsDir : path.resolve(rootDir, config.resultsDir, runId);
  const deployedWorkers = [];
  let activeDatabases = [];
  let rawResult = resume?.raw;

  progress.log("D1 exact provider-region pinning is not exposed by Cloudflare.");
  progress.log("This benchmark tests Worker targeted placement against the observed D1 region.");
  progress.log(`Account: ${accountId}`);
  progress.log(`Run: ${runId}${resume ? " (resumed)" : ""}`);

  await mkdir(tempDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });

  try {
    const workerSourcePath = await copyWorkerSource(rootDir, tempDir);

    if (!rawResult) {
      rawResult = createEmptyRawResult({
        runId,
        startedAt,
        config,
        accountId,
        d1Locations,
        workerPlacementsByD1Location,
        candidatePlacements
      });
    } else {
      prepareRawForResume(rawResult, progress);
    }

    ensureRawDiscoveryState(rawResult, d1Locations);
    const discoveredColosByLocation = createDiscoveredColosByLocation(rawResult, d1Locations);
    const discoveryAttemptsByLocation = createDiscoveryAttemptsByLocation(rawResult, d1Locations);
    const batchRecords = ensureBatchRecords(rawResult, placementBatches);
    for (
      let discoveryWaveIndex = nextDiscoveryWave(rawResult);
      hasRemainingDiscoveryAttempts(discoveryAttemptsByLocation, config);
      discoveryWaveIndex += 1
    ) {
      const waveLabel = `${discoveryWaveIndex + 1}`;
      let databasesToBenchmark = [];
      progress.log(`Starting D1 discovery wave ${waveLabel}...`);

      try {
        databasesToBenchmark = await discoverNewDatabases({
          auth,
          accountId,
          config,
          runId,
          resultsDir,
          rawResult,
          d1Locations,
          discoveryWaveIndex,
          discoveredColosByLocation,
          discoveryAttemptsByLocation,
          activeDatabases,
          progress
        });
        for (const database of databasesToBenchmark) {
          rawResult.databaseColocations.push(serializeDatabaseColocation(database, {
            discoveryWaveIndex,
            attempt: database.discoveryAttempt,
            coloKey: database.coloKey
          }));
        }
        await persistProgress(resultsDir, rawResult);

        if (databasesToBenchmark.length === 0) {
          progress.log(`No new D1 colocations found in discovery wave ${waveLabel}; stopping discovery.`);
          break;
        }

        for (let batchIndex = 0; batchIndex < placementBatches.length; batchIndex += 1) {
          const placements = placementBatches[batchIndex];
          const batchRecord = batchRecords[batchIndex];
          const batchWorkers = [];
          progress.log(`Starting Worker batch ${batchIndex + 1}/${placementBatches.length} for D1 discovery wave ${waveLabel} (${placements.length} Workers)...`);

          try {
            const workers = await deployWorkers({
              accountId,
              config,
              databases: databasesToBenchmark,
              placements,
              batchIndex,
              discoveryWaveIndex,
              runId,
              tempDir,
              workerSourcePath,
              deployedWorkers,
              progress
            });
            batchWorkers.push(...workers);
            batchRecord.rounds.push({
              index: discoveryWaveIndex,
              databases: databasesToBenchmark.map((database) => ({
                key: database.key,
                targetLocation: database.targetLocation,
                observedRegion: database.observedRegion,
                observedColo: database.observedColo,
                coloKey: database.coloKey,
                attempt: database.discoveryAttempt
              })),
              workers
            });
            await persistProgress(resultsDir, rawResult);

            if (config.propagationSeconds > 0) {
              progress.log(`Starting Worker propagation wait (${config.propagationSeconds}s)...`);
              await sleep(config.propagationSeconds * 1000);
              progress.recordPropagationWait();
              progress.log(`Finished Worker propagation wait (${config.propagationSeconds}s).`);
            }

            const measuredRequestsByRound = splitRequestsAcrossRounds(
              config.benchmark.measuredRequests,
              config.benchmark.splitInRounds
            );

            for (let roundIndex = 0; roundIndex < measuredRequestsByRound.length; roundIndex += 1) {
              const measuredRequests = measuredRequestsByRound[roundIndex];
              const benchmarkRoundLabel = `${roundIndex + 1}/${measuredRequestsByRound.length}`;
              progress.log(
                `Starting benchmark round ${benchmarkRoundLabel} (${measuredRequests} measured requests per pair)...`
              );

              for (const database of databasesToBenchmark) {
                const placementsForDatabase = new Set(workerPlacementsByD1Location[database.targetLocation] || []);
                ensureColoResultBucket(rawResult.warmup, database.key, database.coloKey);
                ensureColoResultBucket(rawResult.measured, database.key, database.coloKey);

                for (const worker of workers) {
                  if (!placementsForDatabase.has(worker.placement)) continue;

                  if (!rawResult.warmup[database.key][database.coloKey][worker.placement]) {
                    rawResult.warmup[database.key][database.coloKey][worker.placement] = [];
                  }
                  if (!rawResult.measured[database.key][database.coloKey][worker.placement]) {
                    rawResult.measured[database.key][database.coloKey][worker.placement] = [];
                  }

                  const pairLabel = `D1 ${database.label}/${database.coloKey} x Worker ${worker.placement}`;
                  progress.log(
                    `Starting warmup: round ${benchmarkRoundLabel}, ${pairLabel} (${config.benchmark.warmupRequests} requests)...`
                  );
                  const warmupResults = await runRequests({
                    worker,
                    database,
                    requests: config.benchmark.warmupRequests,
                    queriesPerRequest: config.benchmark.queriesPerRequest,
                    timeoutMs: config.benchmark.requestTimeoutMs,
                    progress
                  });
                  rawResult.warmup[database.key][database.coloKey][worker.placement].push(...warmupResults);
                  await persistProgress(resultsDir, rawResult);
                  progress.log(
                    `Finished warmup: round ${benchmarkRoundLabel}, ${pairLabel} (${warmupResults.length} requests).`
                  );

                  progress.log(
                    `Starting measurement: round ${benchmarkRoundLabel}, ${pairLabel} (${measuredRequests} requests)...`
                  );
                  const measuredResults = await runRequests({
                    worker,
                    database,
                    requests: measuredRequests,
                    queriesPerRequest: config.benchmark.queriesPerRequest,
                    timeoutMs: config.benchmark.requestTimeoutMs,
                    progress
                  });
                  rawResult.measured[database.key][database.coloKey][worker.placement].push(...measuredResults);
                  await persistProgress(resultsDir, rawResult);
                  progress.log(
                    `Finished measurement: round ${benchmarkRoundLabel}, ${pairLabel} (${rawResult.measured[database.key][database.coloKey][worker.placement].length}/${config.benchmark.measuredRequests} measured requests collected).`
                  );
                }
              }

              progress.log(`Finished benchmark round ${benchmarkRoundLabel}.`);
            }

            progress.log(`Finished Worker batch ${batchIndex + 1}/${placementBatches.length} for D1 discovery wave ${waveLabel}.`);
          } finally {
            if (config.cleanupWorkers) {
              await cleanupWorkers(batchWorkers.map((worker) => worker.name), accountId, progress);
              removeDeployedWorkers(deployedWorkers, batchWorkers.map((worker) => worker.name));
            }
          }
        }
        markDiscoveryWaveCompleted(rawResult, discoveryWaveIndex);
        await persistProgress(resultsDir, rawResult);
      } finally {
        for (const database of databasesToBenchmark) {
          if (database.created && config.deleteD1DatabasesAfterRun !== false) {
            await cleanupDatabase(database.name, accountId, progress);
          } else if (database.created) {
            progress.log(`Keeping disposable D1 database ${database.name}.`);
          }
        }
        removeActiveDatabases(activeDatabases, databasesToBenchmark);
      }

      progress.log(`Finished D1 discovery wave ${waveLabel}.`);
    }

    rawResult.run.completedAt = new Date().toISOString();
    await writeOutputs(resultsDir, rawResult);
    await buildAndOpenSite({ config, resultsDir, rootDir, progress });
    const summary = buildSummary(rawResult, benchmarkData);
    printSummary(summary, resultsDir);
  } finally {
    await writePartialIfNeeded(resultsDir, rawResult);
    if (config.cleanupWorkers && deployedWorkers.length > 0) {
      await cleanupWorkers(deployedWorkers, accountId, progress);
    } else if (deployedWorkers.length > 0) {
      progress.log(`Keeping ${deployedWorkers.length} benchmark Workers because cleanupWorkers=false.`);
    }

    for (const database of activeDatabases) {
      const shouldDeleteDatabase =
        database.created &&
        config.deleteD1DatabasesAfterRun !== false;

      if (shouldDeleteDatabase) {
        await cleanupDatabase(database.name, accountId, progress);
      } else if (database.created) {
        progress.log(`Keeping disposable D1 database ${database.name}.`);
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
    else if (arg === "--resume") args.resume = requireValue(argv, ++i, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.resume && args.config) {
    throw new Error("Use either --resume or --config, not both.");
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
  npm run benchmark -- --resume results/2026-06-22_10-14-03_UTC

Default behavior:
  Loads benchmark.config.json, creates D1 databases from data/d1-locations.json, expands Worker
  placements from data/*-regions.json, deploys Workers in batches of up to maxWorkersPerBatch,
  and tests every selected D1 x Worker placement pair.

Environment:
  CLOUDFLARE_API_TOKEN       Recommended Cloudflare API token.
  CLOUDFLARE_ACCOUNT_ID      Optional account ID when the token has multiple accounts.

Options:
  -c, --config <path>        JSON config file. Defaults to benchmark.config.json.
      --resume <folder>      Continue an incomplete run from a results folder.
      --help                 Show this help.

Progress files:
  results/<date-time>/raw.partial.json
`);
}

async function loadConfig(configPath, rootDir) {
  const selectedConfigPath = configPath || DEFAULT_CONFIG_PATH;
  const absolutePath = path.resolve(rootDir, selectedConfigPath);
  const file = await readFile(absolutePath, "utf8");
  return JSON.parse(file);
}

async function loadResumeRun(resultsFolder, rootDir) {
  const resultsDir = path.resolve(rootDir, resultsFolder);
  for (const fileName of ["raw.partial.json", "raw.json"]) {
    const fullPath = path.join(resultsDir, fileName);
    try {
      const raw = JSON.parse(await readFile(fullPath, "utf8"));
      if (raw.run?.completedAt) {
        throw new Error(`Run in ${resultsDir} is already complete.`);
      }
      if (!raw.run?.config) {
        throw new Error(`Resume file ${fullPath} does not contain run.config.`);
      }
      return { resultsDir, raw };
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
  throw new Error(`Could not find raw.partial.json or raw.json in ${resultsDir}.`);
}

function createEmptyRawResult({ runId, startedAt, config, accountId, d1Locations, workerPlacementsByD1Location, candidatePlacements }) {
  return {
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
    databases: d1Locations.map(serializeDatabaseTarget),
    databaseColocations: [],
    workerPlacements: candidatePlacements,
    batches: [],
    discovery: {
      attemptsByLocation: {},
      completedWaves: []
    },
    warmup: {},
    measured: {}
  };
}

function prepareRawForResume(raw, progress) {
  raw.run.completedAt = undefined;
  const incompleteWaves = incompleteDiscoveryWaves(raw);
  if (incompleteWaves.length === 0) return;

  progress.log(`Rolling back incomplete discovery waves before resume: ${incompleteWaves.map((index) => index + 1).join(", ")}.`);
  const incomplete = new Set(incompleteWaves);
  const colocationsToRemove = (raw.databaseColocations || [])
    .filter((database) => incomplete.has(Number(database.discoveryWaveIndex)))
    .map((database) => ({ dbKey: database.key, coloKey: database.coloKey }));

  raw.databaseColocations = (raw.databaseColocations || [])
    .filter((database) => !incomplete.has(Number(database.discoveryWaveIndex)));

  for (const batch of raw.batches || []) {
    batch.rounds = (batch.rounds || []).filter((round) => !incomplete.has(Number(round.index)));
  }

  removeColocationResults(raw.warmup, colocationsToRemove);
  removeColocationResults(raw.measured, colocationsToRemove);
}

function incompleteDiscoveryWaves(raw) {
  const completed = new Set((raw.discovery?.completedWaves || []).map(Number));
  const waves = new Set();
  for (const database of raw.databaseColocations || []) {
    if (Number.isInteger(database.discoveryWaveIndex)) waves.add(database.discoveryWaveIndex);
  }
  for (const batch of raw.batches || []) {
    for (const round of batch.rounds || []) {
      if (Number.isInteger(round.index)) waves.add(round.index);
    }
  }
  return [...waves].filter((index) => !completed.has(index)).sort((a, b) => a - b);
}

function removeColocationResults(results, colocations) {
  for (const { dbKey, coloKey } of colocations) {
    if (results?.[dbKey]) delete results[dbKey][coloKey];
  }
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
  if (!Number.isInteger(config.databaseDiscoveryAttemptsPerRegion) || config.databaseDiscoveryAttemptsPerRegion < 1) {
    throw new Error("databaseDiscoveryAttemptsPerRegion must be a positive integer.");
  }
  requirePlainObject(config.benchmark, "benchmark");
  for (const key of ["warmupRequests", "measuredRequests", "splitInRounds", "queriesPerRequest", "requestTimeoutMs"]) {
    if (!Number.isInteger(config.benchmark[key]) || config.benchmark[key] < 1) {
      throw new Error(`benchmark.${key} must be a positive integer.`);
    }
  }
  if (config.benchmark.splitInRounds > config.benchmark.measuredRequests) {
    throw new Error("benchmark.splitInRounds cannot be greater than benchmark.measuredRequests.");
  }
  if (!Number.isInteger(config.benchmark.minSuccessfulRequests) || config.benchmark.minSuccessfulRequests < 1) {
    throw new Error("benchmark.minSuccessfulRequests must be a positive integer.");
  }
  if (config.benchmark.minSuccessfulRequests > config.benchmark.measuredRequests) {
    throw new Error("benchmark.minSuccessfulRequests cannot be greater than benchmark.measuredRequests.");
  }
  requireBoolean(config.cleanupWorkers, "cleanupWorkers");
  if (!Number.isInteger(config.propagationSeconds) || config.propagationSeconds < 0) {
    throw new Error("propagationSeconds must be a non-negative integer.");
  }
  requireString(config.resultsDir, "resultsDir");
  requireString(config.siteOutputPath, "siteOutputPath");
  requireBoolean(config.openSiteAfterRun, "openSiteAfterRun");
}

function createBenchmarkProgress({ config, d1Locations, workerPlacementsByD1Location, candidatePlacements, placementBatches }) {
  const totalRequests = countPlannedBenchmarkRequests(config, d1Locations, workerPlacementsByD1Location);
  const totals = {
    d1Creates: d1Locations.length * config.databaseDiscoveryAttemptsPerRegion,
    workerCreates: candidatePlacements.length * config.databaseDiscoveryAttemptsPerRegion,
    d1Deletes: config.deleteD1DatabasesAfterRun !== false ? d1Locations.length * config.databaseDiscoveryAttemptsPerRegion : 0,
    workerDeletes: config.cleanupWorkers ? candidatePlacements.length * config.databaseDiscoveryAttemptsPerRegion : 0,
    propagationWaits: config.propagationSeconds > 0 ? placementBatches.length * config.databaseDiscoveryAttemptsPerRegion : 0
  };
  const stats = {
    request: createDurationAverage(),
    d1Create: createDurationAverage(),
    workerCreate: createDurationAverage(),
    d1Delete: createDurationAverage(),
    workerDelete: createDurationAverage()
  };
  const completed = {
    requests: 0,
    propagationWaits: 0
  };

  return {
    log(message) {
      console.log(`${progressPrefix()} ${message}`);
    },
    warn(message) {
      console.warn(`${progressPrefix()} ${message}`);
    },
    recordRequest(ms) {
      completed.requests += 1;
      stats.request.record(ms);
    },
    recordD1Create(ms) {
      stats.d1Create.record(ms);
    },
    recordWorkerCreate(ms) {
      stats.workerCreate.record(ms);
    },
    recordD1Delete(ms) {
      stats.d1Delete.record(ms);
    },
    recordWorkerDelete(ms) {
      stats.workerDelete.record(ms);
    },
    recordPropagationWait() {
      completed.propagationWaits += 1;
    }
  };

  function progressPrefix() {
    const requestProgress = formatRequestProgress(completed.requests, totalRequests);
    const etaMs = estimateRemainingMs();
    if (etaMs == null) return `[${requestProgress}]`;
    return `[${requestProgress}, eta: ${formatDuration(etaMs)}]`;
  }

  function estimateRemainingMs() {
    if (stats.request.count === 0) return null;

    return (
      remaining(totalRequests, completed.requests) * stats.request.averageMs +
      remaining(totals.d1Creates, stats.d1Create.count) * knownAverage(stats.d1Create) +
      remaining(totals.workerCreates, stats.workerCreate.count) * knownAverage(stats.workerCreate) +
      remaining(totals.d1Deletes, stats.d1Delete.count) * knownAverage(stats.d1Delete) +
      remaining(totals.workerDeletes, stats.workerDelete.count) * knownAverage(stats.workerDelete) +
      remaining(totals.propagationWaits, completed.propagationWaits) * config.propagationSeconds * 1000
    );
  }
}

function countPlannedBenchmarkRequests(config, d1Locations, workerPlacementsByD1Location) {
  const requestsPerPair =
    config.benchmark.measuredRequests +
    config.benchmark.warmupRequests * config.benchmark.splitInRounds;
  const pairCount = d1Locations.reduce(
    (count, location) => count + unique(workerPlacementsByD1Location[location] || []).length,
    0
  );
  return pairCount * requestsPerPair * config.databaseDiscoveryAttemptsPerRegion;
}

function hasRemainingDiscoveryAttempts(discoveryAttemptsByLocation, config) {
  return [...discoveryAttemptsByLocation.values()].some(
    (attempts) => attempts < config.databaseDiscoveryAttemptsPerRegion
  );
}

function ensureRawDiscoveryState(raw, d1Locations) {
  if (!raw.discovery || typeof raw.discovery !== "object" || Array.isArray(raw.discovery)) {
    raw.discovery = {};
  }
  if (!raw.discovery.attemptsByLocation || typeof raw.discovery.attemptsByLocation !== "object") {
    raw.discovery.attemptsByLocation = {};
  }
  if (!Array.isArray(raw.discovery.completedWaves)) {
    raw.discovery.completedWaves = [];
  }
  for (const location of d1Locations) {
    if (!Number.isInteger(raw.discovery.attemptsByLocation[location])) {
      raw.discovery.attemptsByLocation[location] = maxRecordedAttempt(raw, location);
    }
  }
}

function createDiscoveredColosByLocation(raw, d1Locations) {
  const map = new Map(d1Locations.map((location) => [location, new Set()]));
  for (const database of raw.databaseColocations || []) {
    if (!map.has(database.targetLocation)) continue;
    if (database.coloKey) map.get(database.targetLocation).add(database.coloKey);
  }
  return map;
}

function createDiscoveryAttemptsByLocation(raw, d1Locations) {
  ensureRawDiscoveryState(raw, d1Locations);
  return new Map(d1Locations.map((location) => [
    location,
    Number(raw.discovery.attemptsByLocation[location]) || 0
  ]));
}

function maxRecordedAttempt(raw, location) {
  return Math.max(
    0,
    ...(raw.databaseColocations || [])
      .filter((database) => database.targetLocation === location)
      .map((database) => Number(database.attempt) || 0)
  );
}

function ensureBatchRecords(raw, placementBatches) {
  if (!Array.isArray(raw.batches)) raw.batches = [];
  return placementBatches.map((placements, index) => {
    let batch = raw.batches.find((candidate) => candidate.index === index);
    if (!batch) {
      batch = { index, placements, rounds: [] };
      raw.batches.push(batch);
    }
    batch.placements = placements;
    if (!Array.isArray(batch.rounds)) batch.rounds = [];
    return batch;
  });
}

function nextDiscoveryWave(raw) {
  const completed = raw.discovery?.completedWaves || [];
  return completed.length ? Math.max(...completed.map(Number).filter(Number.isFinite)) + 1 : 0;
}

function markDiscoveryWaveCompleted(raw, discoveryWaveIndex) {
  ensureRawDiscoveryState(raw, raw.databases?.map((database) => database.targetLocation || database.key) || []);
  if (!raw.discovery.completedWaves.includes(discoveryWaveIndex)) {
    raw.discovery.completedWaves.push(discoveryWaveIndex);
    raw.discovery.completedWaves.sort((a, b) => a - b);
  }
}

function createDurationAverage() {
  let count = 0;
  let averageMs = 0;
  return {
    get count() {
      return count;
    },
    get averageMs() {
      return averageMs;
    },
    record(ms) {
      if (!Number.isFinite(ms) || ms < 0) return;
      count += 1;
      averageMs += (ms - averageMs) / count;
    }
  };
}

function knownAverage(stat) {
  return stat.count > 0 ? stat.averageMs : 0;
}

function remaining(total, completed) {
  return Math.max(0, total - completed);
}

function formatRequestProgress(completedRequests, totalRequests) {
  const width = Math.max(5, String(Math.max(completedRequests, totalRequests)).length);
  return `#${String(completedRequests).padStart(width, "0")}/${totalRequests}`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds === 0) return "0s";

  const units = [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
    ["s", 1]
  ];
  const parts = [];
  let remainder = seconds;
  for (const [label, unitSeconds] of units) {
    const value = Math.floor(remainder / unitSeconds);
    if (value > 0) {
      parts.push(`${value}${label}`);
      remainder -= value * unitSeconds;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ");
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

async function discoverNewDatabases({
  auth,
  accountId,
  config,
  runId,
  resultsDir,
  rawResult,
  d1Locations,
  discoveryWaveIndex,
  discoveredColosByLocation,
  discoveryAttemptsByLocation,
  activeDatabases,
  progress
}) {
  const databases = [];
  const maxAttempts = config.databaseDiscoveryAttemptsPerRegion;

  for (const location of d1Locations) {
    while ((discoveryAttemptsByLocation.get(location) || 0) < maxAttempts) {
      const attempt = (discoveryAttemptsByLocation.get(location) || 0) + 1;
      discoveryAttemptsByLocation.set(location, attempt);
      rawResult.discovery.attemptsByLocation[location] = attempt;
      await persistProgress(resultsDir, rawResult);

      const database = await prepareDisposableDatabase({
        auth,
        accountId,
        config,
        runId,
        location,
        discoveryWaveIndex,
        attempt,
        progress
      });
      activeDatabases.push(database);

      progress.log(
        `D1 database: ${database.name} (${database.id}), target=${database.targetLocation ?? "unknown"}, observed=${database.observedRegion ?? "unknown"}, colo=${database.observedColo ?? "unknown"}, attempt=${attempt}/${maxAttempts}`
      );

      const discoveredColos = discoveredColosByLocation.get(location);
      if (!discoveredColos.has(database.coloKey)) {
        discoveredColos.add(database.coloKey);
        databases.push(database);
        break;
      }

      progress.log(`Discarding D1 ${location} colo ${database.coloKey}; already tested in this run.`);
      if (database.created && config.deleteD1DatabasesAfterRun !== false) {
        await cleanupDatabase(database.name, accountId, progress);
      } else if (database.created) {
        progress.log(`Keeping disposable D1 database ${database.name}.`);
      }
      removeActiveDatabases(activeDatabases, [database]);
      await persistProgress(resultsDir, rawResult);
    }

    if ((discoveryAttemptsByLocation.get(location) || 0) >= maxAttempts && !databases.some((database) => database.targetLocation === location)) {
      progress.log(`D1 ${location} discovery attempts exhausted (${maxAttempts}).`);
    }
  }

  return databases;
}

async function prepareDisposableDatabase({ auth, accountId, config, runId, location, discoveryWaveIndex, attempt, progress }) {
  const name = `${config.d1DatabaseNamePrefix}-w${discoveryWaveIndex + 1}-a${attempt}-${location}-${Date.now()}`;
  const databaseConfig = config.database || {};
  const started = performance.now();
  progress.log(`Starting disposable D1 database setup: ${name} (${location})...`);
  const createdDatabase = await createD1Database(
    name,
    { ...databaseConfig, location, jurisdiction: undefined },
    accountId,
    progress
  );
  await registerResource({
    type: "d1",
    accountId,
    runId,
    name,
    id: createdDatabase.id,
    metadata: { targetLocation: location, discoveryWaveIndex, attempt }
  });
  const database = await prepareOneDatabase({
    auth,
    accountId,
    databaseConfig: createdDatabase.id ? { id: createdDatabase.id, name } : { name },
    created: true,
    targetLocation: location,
    label: location,
    progress
  });
  database.discoveryWaveIndex = discoveryWaveIndex;
  database.discoveryAttempt = attempt;
  progress.recordD1Create(performance.now() - started);
  progress.log(`Finished disposable D1 database setup: ${name} (${database.id}).`);
  return database;
}

async function prepareOneDatabase({ auth, accountId, databaseConfig, created, targetLocation, label, progress }) {
  const database = await findDatabase(auth, accountId, databaseConfig);
  await seedDatabase(database.name, accountId, progress);
  const observed = await observeD1Region(auth, accountId, database.id, progress);
  const info = await getDatabaseInfo(auth, accountId, database.id).catch(() => undefined);
  const observedRegion = observed?.servedByRegion ?? info?.running_in_region ?? info?.primary_location_hint;
  const observedColo = observed?.servedByColo;
  const coloKey = databaseColocationKey({ observedColo, observedRegion });

  return {
    key: makeDatabaseKey(label || database.name),
    label: label || database.name,
    id: database.id,
    name: database.name,
    created,
    targetLocation,
    jurisdiction: database.jurisdiction ?? info?.jurisdiction,
    observedRegion,
    observedColo,
    coloKey,
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

async function createD1Database(name, databaseConfig, accountId, progress) {
  progress.log(`Starting D1 database creation: ${name}...`);
  const args = ["d1", "create", name];
  if (databaseConfig.jurisdiction) {
    args.push("--jurisdiction", databaseConfig.jurisdiction);
  } else if (databaseConfig.location) {
    args.push("--location", databaseConfig.location);
  }
  const output = await runWrangler(args, { CLOUDFLARE_ACCOUNT_ID: accountId });
  progress.log(`Finished D1 database creation: ${name}.`);
  return {
    name,
    id: extractD1DatabaseId(output),
    rawOutput: output
  };
}

async function seedDatabase(databaseName, accountId, progress) {
  progress.log(`Starting benchmark table seed: ${databaseName}...`);
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
  progress.log(`Finished benchmark table seed: ${databaseName}.`);
}

async function observeD1Region(auth, accountId, databaseId, progress) {
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
    progress.warn(`Could not observe D1 region through the query API: ${error.message}`);
    return undefined;
  }
}

async function deployWorkers({ accountId, config, databases, placements, batchIndex, discoveryWaveIndex, runId, tempDir, workerSourcePath, deployedWorkers, progress }) {
  const workers = [];

  for (const placement of placements) {
    const workerName = sanitizeWorkerName(`${config.workerNamePrefix}-b${batchIndex + 1}-w${discoveryWaveIndex + 1}-${placement}`);
    const started = performance.now();
    progress.log(`Starting Worker deployment: ${workerName} (${placement})...`);
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

    const deployOutput = await deployWorkerWithRetry(workerName, placement, configPath, accountId, progress);
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
      metadata: { placement, batchIndex, discoveryWaveIndex }
    });
    workers.push({ name: workerName, placement, url, configPath });
    progress.recordWorkerCreate(performance.now() - started);
    progress.log(`Finished Worker deployment: ${workerName} (${placement}).`);
  }

  return workers;
}

async function deployWorkerWithRetry(workerName, placement, configPath, accountId, progress) {
  for (let attempt = 1; attempt <= WORKER_DEPLOY_RETRY_ATTEMPTS; attempt += 1) {
    progress.log(`Starting Worker deploy attempt ${attempt}/${WORKER_DEPLOY_RETRY_ATTEMPTS}: ${workerName} (${placement})...`);
    try {
      const output = await runWrangler(["deploy", "--config", configPath, "--minify"], {
        CLOUDFLARE_ACCOUNT_ID: accountId
      });
      progress.log(`Finished Worker deploy attempt ${attempt}/${WORKER_DEPLOY_RETRY_ATTEMPTS}: ${workerName} (${placement}).`);
      return output;
    } catch (error) {
      if (attempt >= WORKER_DEPLOY_RETRY_ATTEMPTS || !isRetryableWorkerDeployError(error)) {
        throw error;
      }
      progress.warn(
        `Worker deploy failed while Cloudflare prepared bindings; retrying in ${Math.round(WORKER_DEPLOY_RETRY_DELAY_MS / 1000)}s (${attempt + 1}/${WORKER_DEPLOY_RETRY_ATTEMPTS})...`
      );
      await sleep(WORKER_DEPLOY_RETRY_DELAY_MS);
    }
  }
}

function isRetryableWorkerDeployError(error) {
  const text = `${error?.message || ""}\n${error?.stdout || ""}\n${error?.stderr || ""}`;
  return /binding\s+\S+\s+of type d1 failed to generate/i.test(text) || /\bcode:\s*10021\b/i.test(text);
}

async function copyWorkerSource(rootDir, tempDir) {
  const sourcePath = path.join(rootDir, "src", "benchmark-worker-source.mjs");
  const targetPath = path.join(tempDir, "benchmark-worker-source.mjs");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(targetPath, source, "utf8");
  return targetPath;
}

async function runRequests({ worker, database, requests, queriesPerRequest, timeoutMs, progress }) {
  const results = [];
  for (let requestIndex = 0; requestIndex < requests; requestIndex += 1) {
    const started = performance.now();
    results[requestIndex] = await callBench(worker, database, queriesPerRequest, timeoutMs);
    progress.recordRequest(performance.now() - started);
  }
  return results;
}

function splitRequestsAcrossRounds(requests, rounds) {
  const baseRequests = Math.floor(requests / rounds);
  const extraRequests = requests % rounds;
  return Array.from({ length: rounds }, (_, roundIndex) => baseRequests + (roundIndex < extraRequests ? 1 : 0));
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
    const placementHeader = response.headers.get("cf-placement");
    const placement = parsePlacementHeader(placementHeader);
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
        workerName: worker.name,
        workerPlacement: worker.placement,
        workerUrl: worker.url,
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
      workerName: worker.name,
      workerPlacement: worker.placement,
      workerUrl: worker.url,
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
      workerName: worker.name,
      workerPlacement: worker.placement,
      workerUrl: worker.url,
      clientMs: performance.now() - started,
      error: error.name === "AbortError" ? "request_timeout" : error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildSummary(raw, benchmarkData) {
  const databases = (raw.databases || [raw.database]).filter(Boolean);
  const databaseByKey = Object.fromEntries(databases.map((database) => [database.key, database]));
  const byDatabase = {};
  const allRanked = [];
  const minSuccessfulRequests = getMinSuccessfulRequests(raw.run?.config);

  for (const database of databases) {
    const placements = [];
    for (const [coloKey, byPlacement] of Object.entries(raw.measured?.[database.key] || {})) {
      const colocatedDatabase = databaseForColocation(raw, databaseByKey, database.key, coloKey);
      placements.push(...Object.entries(byPlacement || {}).map(([placement, requests]) =>
        summarizePlacement({
          raw,
          database: colocatedDatabase,
          placement,
          requests,
          minSuccessfulRequests
        })
      ));
    }
    const ranked = placements
      .slice()
      .sort((a, b) => compareNullable(a[DEFAULT_AGGREGATE_FIELD], b[DEFAULT_AGGREGATE_FIELD]) || compareNullable(a.avgDbMs, b.avgDbMs))
      .map((item, index) => ({ rank: index + 1, ...item }));

    byDatabase[database.key] = {
      database,
      placements,
      ranked,
      recommendation: ranked.find((item) => item.status === "ok")
        ? `Use ${ranked.find((item) => item.status === "ok").placement} for D1 ${database.label} based on the lowest ${DEFAULT_AGGREGATE_METRIC} latency in this run.`
        : `No successful benchmark requests were recorded for D1 ${database.label}.`
    };
    allRanked.push(...ranked.map((item) => ({ ...item, databaseKey: database.key, databaseLabel: database.label })));
  }

  const best = allRanked
    .filter((item) => item.status === "ok")
    .sort((a, b) => compareNullable(a[DEFAULT_AGGREGATE_FIELD], b[DEFAULT_AGGREGATE_FIELD]) || compareNullable(a.avgDbMs, b.avgDbMs))[0];

  return {
    run: raw.run,
    databases,
    byDatabase,
    ranked: allRanked,
    recommendation: best
      ? `Best observed pair: D1 ${best.databaseLabel} x Worker ${best.placement} based on the lowest ${DEFAULT_AGGREGATE_METRIC} latency in this run.`
      : "No successful benchmark requests were recorded."
  };
}

function databaseForColocation(raw, databaseByKey, dbKey, coloKey) {
  const target = databaseByKey[dbKey] || { key: dbKey, label: dbKey, targetLocation: dbKey };
  const observed = (raw.databaseColocations || []).find((database) => database.key === dbKey && database.coloKey === coloKey);
  return {
    ...target,
    ...observed,
    key: dbKey,
    label: target.label || observed?.label || dbKey,
    targetLocation: target.targetLocation || observed?.targetLocation,
    observedRegion: observed?.observedRegion || target.observedRegion,
    observedColo: observed?.observedColo || target.observedColo,
    coloKey
  };
}

function summarizePlacement({ raw, database, placement, requests, minSuccessfulRequests }) {
  const successes = requests.filter((request) => request && request.ok);
  const errors = requests.filter((request) => !request?.ok);
  const measurements = getPairMeasurements({ requests, database });
  const successful = measurements.successful;
  const reliable = isPairReliable(successful.length, minSuccessfulRequests);
  const rawServerTimes = reliable ? successful.map((request) => request.body?.totalMs).filter(isFiniteNumber) : [];
  const perQueryTimes = reliable ? successful.flatMap((request) => adjustedPerQueryMs(request.body)).filter(isFiniteNumber) : [];
  const rawPerQueryTimes = reliable ? successful.flatMap((request) => request.body?.perQueryMs ?? []).filter(isFiniteNumber) : [];
  const sqlDurations = reliable ? successful.flatMap((request) => request.body?.d1?.sqlDurations ?? []).filter(isFiniteNumber) : [];
  const workerColos = countValues(successes.map((request) => request.body?.workerColo).filter(Boolean));
  const placementColos = countValues(successes.map((request) => request.placementColo).filter(Boolean));
  const d1Regions = mergeCounts(successes.map((request) => request.body?.d1?.regions));
  const d1Colos = mergeCounts(successes.map((request) => request.body?.d1?.colos));
  const worker = findWorker(raw, placement, requests);

  return {
    databaseKey: database.key,
    databaseLabel: database.label,
    databaseName: database.name,
    d1TargetLocation: database.targetLocation,
    d1ObservedRegion: database.observedRegion,
    d1ObservedColo: database.observedColo,
    d1ColoKey: database.coloKey,
    placement,
    workerName: worker?.name,
    url: worker?.url,
    requestCount: requests.length,
    httpSuccessCount: successes.length,
    successCount: successful.length,
    noteCounts: measurements.noteCounts,
    minSuccessfulRequests,
    successRatio: requests.length ? successful.length / requests.length : 0,
    status: reliable ? "ok" : "failed",
    errorCount: errors.length,
    errors: summarizeErrors(errors),
    avgDbMs: average(perQueryTimes),
    p50DbMs: percentile(perQueryTimes, 50),
    p90DbMs: percentile(perQueryTimes, 90),
    p95DbMs: percentile(perQueryTimes, 95),
    p99DbMs: percentile(perQueryTimes, 99),
    minDbMs: min(perQueryTimes),
    maxDbMs: max(perQueryTimes),
    stddevDbMs: stddev(perQueryTimes),
    avgPerQueryMs: average(perQueryTimes),
    avgRawDbMs: average(rawServerTimes),
    avgRawPerQueryMs: average(rawPerQueryTimes),
    avgD1SqlDurationMs: average(sqlDurations),
    placementColos,
    workerColos,
    d1Regions,
    d1Colos
  };
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

function findWorker(raw, placement, requests = []) {
  const requestWorkerName = requests.find((request) => request?.workerName)?.workerName;
  for (const batch of raw.batches || []) {
    const worker = batch.workers?.find((candidate) =>
      requestWorkerName ? candidate.name === requestWorkerName : candidate.placement === placement
    );
    if (worker) return worker;
    for (const round of batch.rounds || []) {
      const roundWorker = round.workers?.find((candidate) =>
        requestWorkerName ? candidate.name === requestWorkerName : candidate.placement === placement
      );
      if (roundWorker) return roundWorker;
    }
  }
  return undefined;
}

function summarizeErrors(errors) {
  return countValues(errors.map((error) => error.error || `HTTP ${error.status}`));
}

function ensureResultBucket(object, key) {
  if (!object[key]) object[key] = {};
}

function ensureColoResultBucket(object, key, coloKey) {
  ensureResultBucket(object, key);
  if (!object[key][coloKey]) object[key][coloKey] = {};
}

function serializeDatabaseTarget(location) {
  return {
    key: makeDatabaseKey(location),
    label: location,
    targetLocation: location
  };
}

function serializeDatabaseColocation(database, { discoveryWaveIndex, attempt, coloKey }) {
  return {
    key: database.key,
    label: database.label,
    id: database.id,
    name: database.name,
    createdByBenchmark: database.created,
    targetLocation: database.targetLocation,
    observedRegion: database.observedRegion,
    observedColo: database.observedColo,
    coloKey,
    discoveryWaveIndex,
    attempt,
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

function databaseColocationKey(database) {
  return normalizeD1Colo(database?.observedColo) || normalizeD1Region(database?.observedRegion) || "unknown";
}

function normalizeD1Colo(value) {
  return value == null || value === "" ? null : String(value).trim().toUpperCase();
}

function normalizeD1Region(value) {
  return value == null || value === "" ? null : String(value).trim().toUpperCase();
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

function removeActiveDatabases(activeDatabases, databases) {
  const names = new Set(databases.map((database) => database.name));
  for (let index = activeDatabases.length - 1; index >= 0; index -= 1) {
    if (names.has(activeDatabases[index].name)) activeDatabases.splice(index, 1);
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

async function buildAndOpenSite({ config, resultsDir, rootDir, progress }) {
  const inputPath = path.join(resultsDir, "raw.json");
  const args = [
    path.join(rootDir, "src", "build-html-site.mjs"),
    "--input",
    inputPath,
    "--output",
    config.siteOutputPath,
    config.openSiteAfterRun ? "--open" : "--no-open"
  ];
  progress.log(`Starting benchmark report build: ${config.siteOutputPath}...`);
  await runCommand(process.execPath, args);
  progress.log(`Finished benchmark report build: ${config.siteOutputPath}.`);
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
    const row = entry.ranked.find((item) => item.status === "ok");
    if (row) {
      console.log(
        `${entry.database.label}: ${row.placement} ${DEFAULT_AGGREGATE_METRIC}=${formatMs(row[DEFAULT_AGGREGATE_FIELD])} avg=${formatMs(row.avgDbMs)} successful=${row.successCount}/${row.requestCount} errors=${row.errorCount}`
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

async function cleanupWorkers(workerNames, accountId, progress) {
  for (const workerName of workerNames.slice().reverse()) {
    try {
      const started = performance.now();
      progress.log(`Starting Worker deletion: ${workerName}...`);
      await runWrangler(["delete", workerName, "--force"], {
        CLOUDFLARE_ACCOUNT_ID: accountId
      });
      await unregisterResource({ type: "worker", accountId, name: workerName });
      progress.recordWorkerDelete(performance.now() - started);
      progress.log(`Finished Worker deletion: ${workerName}.`);
    } catch (error) {
      if (isAlreadyDeletedError(error)) {
        await unregisterResource({ type: "worker", accountId, name: workerName });
      } else {
        progress.warn(`Could not delete Worker ${workerName}: ${error.message}`);
      }
    }
  }
}

async function cleanupDatabase(databaseName, accountId, progress) {
  try {
    const started = performance.now();
    progress.log(`Starting disposable D1 database deletion: ${databaseName}...`);
    await runWrangler(["d1", "delete", databaseName, "--skip-confirmation"], {
      CLOUDFLARE_ACCOUNT_ID: accountId
    });
    await unregisterResource({ type: "d1", accountId, name: databaseName });
    progress.recordD1Delete(performance.now() - started);
    progress.log(`Finished disposable D1 database deletion: ${databaseName}.`);
  } catch (error) {
    if (isAlreadyDeletedError(error)) {
      await unregisterResource({ type: "d1", accountId, name: databaseName });
    } else {
      progress.warn(`Could not delete D1 database ${databaseName}: ${error.message}`);
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
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}_${iso.slice(11, 19).replace(/:/g, "-")}_UTC`;
}

function redactConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

main().catch((error) => {
  console.error("");
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
