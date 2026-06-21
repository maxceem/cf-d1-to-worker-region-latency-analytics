#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export const RESOURCE_REGISTRY_DIR = ".benchmark-resources";
export const RESOURCE_REGISTRY_FILE = path.join(RESOURCE_REGISTRY_DIR, "resources.json");

const LOCK_DIR = path.join(RESOURCE_REGISTRY_DIR, ".lock");
const LOCK_STALE_MS = 120000;

export async function registerResource(resource) {
  await withRegistryLock(async () => {
    const registry = await readRegistryUnlocked();
    const normalized = normalizeResource(resource);
    const existingIndex = registry.resources.findIndex((item) => item.key === normalized.key);
    if (existingIndex >= 0) {
      registry.resources[existingIndex] = { ...registry.resources[existingIndex], ...normalized };
    } else {
      registry.resources.push(normalized);
    }
    await writeRegistryUnlocked(registry);
  });
}

export async function unregisterResource(resource) {
  await withRegistryLock(async () => {
    const registry = await readRegistryUnlocked();
    const key = resource.key || makeResourceKey(resource);
    registry.resources = registry.resources.filter((item) => item.key !== key);
    await writeRegistryUnlocked(registry);
  });
}

export async function listResources(filter = {}) {
  return withRegistryLock(async () => {
    const registry = await readRegistryUnlocked();
    return registry.resources.filter((resource) => matchesFilter(resource, filter));
  });
}

export async function cleanupTrackedResources(filter = {}) {
  const resources = await listResources(filter);
  if (resources.length === 0) {
    return { attempted: 0, remaining: 0 };
  }

  const workers = resources.filter((resource) => resource.type === "worker");
  const databases = resources.filter((resource) => resource.type === "d1");

  for (const worker of workers.slice().reverse()) {
    await cleanupWorker(worker);
  }

  for (const database of databases.slice().reverse()) {
    await cleanupDatabase(database);
  }

  const remaining = await listResources(filter);
  return { attempted: resources.length, remaining: remaining.length };
}

export function makeResourceKey(resource) {
  return `${resource.type}:${resource.accountId}:${resource.name}`;
}

function matchesFilter(resource, filter) {
  if (filter.runId && resource.runId !== filter.runId) return false;
  if (filter.accountId && resource.accountId !== filter.accountId) return false;
  if (filter.type && resource.type !== filter.type) return false;
  if (filter.scope && resource.metadata?.scope !== filter.scope) return false;
  if (filter.names && !filter.names.includes(resource.name)) return false;
  return true;
}

function normalizeResource(resource) {
  if (!resource.type || !resource.accountId || !resource.name || !resource.runId) {
    throw new Error("Resource tracker entries require type, accountId, name, and runId.");
  }

  return {
    key: makeResourceKey(resource),
    type: resource.type,
    accountId: resource.accountId,
    runId: resource.runId,
    name: resource.name,
    id: resource.id,
    url: resource.url,
    createdAt: resource.createdAt || new Date().toISOString(),
    metadata: resource.metadata || {}
  };
}

async function cleanupWorker(resource) {
  try {
    console.log(`Deleting Worker ${resource.name}...`);
    await runWrangler(["delete", resource.name, "--force"], resource.accountId);
    await unregisterResource(resource);
  } catch (error) {
    if (isAlreadyDeletedError(error)) {
      await unregisterResource(resource);
    } else {
      console.warn(`Could not delete Worker ${resource.name}: ${error.message}`);
    }
  }
}

async function cleanupDatabase(resource) {
  try {
    console.log(`Deleting D1 database ${resource.name}...`);
    await runWrangler(["d1", "delete", resource.name, "--skip-confirmation"], resource.accountId);
    await unregisterResource(resource);
  } catch (error) {
    if (isAlreadyDeletedError(error)) {
      await unregisterResource(resource);
    } else {
      console.warn(`Could not delete D1 database ${resource.name}: ${error.message}`);
    }
  }
}

async function runWrangler(args, accountId) {
  const wranglerLogPath = process.env.WRANGLER_LOG_PATH || ".benchmark-tmp/wrangler-logs";
  await mkdir(wranglerLogPath, { recursive: true });
  return runCommand("wrangler", args, {
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      WRANGLER_LOG_PATH: wranglerLogPath
    }
  });
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`${command} ${args.join(" ")} failed with exit code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
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

async function withRegistryLock(fn) {
  await mkdir(RESOURCE_REGISTRY_DIR, { recursive: true });
  await acquireLock();
  try {
    return await fn();
  } finally {
    await rm(LOCK_DIR, { recursive: true, force: true });
  }
}

async function acquireLock() {
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(LOCK_DIR);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await removeStaleLock();
      if (Date.now() - startedAt > 30000) {
        throw new Error(`Timed out waiting for resource tracker lock at ${LOCK_DIR}`);
      }
      await sleep(100);
    }
  }
}

async function removeStaleLock() {
  try {
    const info = await stat(LOCK_DIR);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      await rm(LOCK_DIR, { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function readRegistryUnlocked() {
  try {
    const file = await readFile(RESOURCE_REGISTRY_FILE, "utf8");
    const registry = JSON.parse(file);
    return {
      version: 1,
      resources: Array.isArray(registry.resources) ? registry.resources : []
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { version: 1, resources: [] };
    }
    throw error;
  }
}

async function writeRegistryUnlocked(registry) {
  await mkdir(RESOURCE_REGISTRY_DIR, { recursive: true });
  const tempPath = `${RESOURCE_REGISTRY_FILE}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await rename(tempPath, RESOURCE_REGISTRY_FILE);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "finder") args.scope = "finder";
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--run-id") args.runId = requireValue(argv, ++i, arg);
    else if (arg === "--account-id") args.accountId = requireValue(argv, ++i, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
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
  npm run cleanup
  npm run cleanup -- finder
  npm run cleanup -- --dry-run
  npm run cleanup -- finder --dry-run
  npm run cleanup -- --run-id <run-id>
  npm run cleanup -- --account-id <account-id>

Deletes all resources still tracked in .benchmark-resources/resources.json.
Entries are removed from the tracker only after deletion succeeds or Cloudflare
confirms the resource no longer exists.

Use --dry-run to print the matching tracked resources without deleting them.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

const resources = await listResources({
    runId: args.runId,
    accountId: args.accountId,
    scope: args.scope
  });

  if (resources.length === 0) {
    console.log("No tracked benchmark resources need cleanup.");
    return;
  }

  if (args.dryRun) {
    console.log(`Tracked benchmark resources matching filters: ${resources.length}`);
    printResources(resources);
    return;
  }

  console.log(`Cleaning ${resources.length} tracked benchmark resources...`);
  const result = await cleanupTrackedResources({
    runId: args.runId,
    accountId: args.accountId,
    scope: args.scope
  });
  console.log(`Cleanup complete. Remaining tracked resources: ${result.remaining}`);
  if (result.remaining > 0) {
    process.exitCode = 1;
  }
}

function printResources(resources) {
  const rows = resources
    .slice()
    .sort((a, b) => a.type.localeCompare(b.type) || a.runId.localeCompare(b.runId) || a.name.localeCompare(b.name));
  for (const resource of rows) {
    const id = resource.id ? ` id=${resource.id}` : "";
    const url = resource.url ? ` url=${resource.url}` : "";
    console.log(`${resource.type} ${resource.name} run=${resource.runId} account=${resource.accountId}${id}${url}`);
  }
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isCli) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
