# D1 Placement Benchmark

One command creates benchmark D1 databases, deploys temporary benchmark Workers with targeted Cloudflare placement in batches, measures Worker-to-D1 latency inside each Worker, writes raw benchmark data, and removes temporary resources.

## Quick run with a disposable D1 database

```bash
CLOUDFLARE_API_TOKEN=... npm run benchmark
```

The default run uses `benchmark.config.json`, creates one temporary D1 database for each configured D1 location hint, seeds a small table in each, tests every configured Worker placement against every D1 database, writes `results/raw.json`, then deletes the temporary Workers and D1 databases.

Workers are deployed in batches. The default cap is 50 Workers at a time:

```json
{
  "maxWorkersPerBatch": 50
}
```

During the run, progress is continuously written to:

```text
results/raw.partial.json
```

Created Cloudflare resources are tracked by [src/clean-resources.mjs](src/clean-resources.mjs) in:

```text
.benchmark-resources/resources.json
```

Each D1 database or Worker is added immediately after creation/deployment succeeds. Each entry is removed only after cleanup succeeds or Cloudflare confirms the resource no longer exists.

If a run fails or is interrupted, the benchmark attempts to clean up the current run automatically. If cleanup cannot finish, run:

```bash
npm run cleanup
```

That cleanup command reads all remaining tracked resources from previous runs and deletes them. You can narrow it with `--run-id` or `--account-id`.

## Customize a benchmark run

```bash
CLOUDFLARE_API_TOKEN=... npm run benchmark -- --config benchmark.config.json
```

`accountId` is optional when the token can list exactly one Cloudflare account. If your token can access multiple accounts, set either `accountId` in the config or `CLOUDFLARE_ACCOUNT_ID`.

To reduce the matrix, edit `benchmark.config.json`. For example:

```json
{
  "database": {
    "locations": ["enam", "wnam"]
  },
  "candidateProviders": ["aws"],
  "candidatePlacements": ["gcp:us-central1", "azure:eastus2"],
  "maxWorkersPerBatch": 20
}
```

`candidateProviders` expands from `data/aws-regions.json`, `data/gcp-regions.json`, and `data/azure-regions.json`. `candidatePlacements` adds explicit placements on top.

## Static website

Turn a finished run's `raw.json` into a single self-contained, interactive static website:

```bash
npm run site
# or point at a specific file / output:
npm run site -- --input results/raw.json --output site/index.html
```

With no arguments it reads `results/raw.json` (falling back to `results-partial/raw.json`) and writes `site/index.html`, then opens it in your default browser. Pass `--no-open` to skip that. The file embeds all data and needs no server or network.

Before publishing updated results, rebuild the committed site:

```bash
npm run build:site
```

The raw benchmark output in `results/` is ignored because it can be large. GitHub Pages deploys the prebuilt `site/` folder committed to the repository; it does not run the benchmark or rebuild the site.

The page lets you:

- See the **whole matrix** of every D1 region × Worker placement as a colored heatmap (green = faster, red = slower), with the best Worker per D1 region outlined.
- **Filter to a single D1 region** to get its recommended Worker placement, a ranked bar chart, and a detailed stats table (avg, p50/p90/p95/p99, min/max, stddev, per-query, errors).
- Switch the **comparison metric** (avg, p50, p90, p95, p99, min, max) and sort any table column.
- See the global **best D1 × Worker pair** highlighted at the top.

The report also includes a per-D1 **world map** (the D1 location plus an arc to every Worker location, colored by latency), embedding a simplified world basemap from `data/world-basemap.json`. Region→city coordinates come from the providers' own region documentation (AWS, Google Cloud, and Azure region lists). To add a missing or new region, edit the `PROVIDER_COORDS` / `D1_COORDS` tables in [src/build-html-site.mjs](src/build-html-site.mjs).

## Credentials

Recommended:

```bash
export CLOUDFLARE_API_TOKEN=...
```

Legacy global API key auth is also supported for API calls and Wrangler if you set both:

```bash
export CLOUDFLARE_EMAIL=you@example.com
export CLOUDFLARE_API_KEY=...
```

The token/key needs permission to read accounts, manage D1, and deploy/delete Workers.

## Useful flags

```bash
npm run benchmark -- --config benchmark.config.json
npm run cleanup
npm run benchmark -- --keep-workers
npm run benchmark -- --keep-database
npm run benchmark -- --results-dir custom-results
```

D1 exact provider-region pinning is not exposed. D1 creation accepts only Cloudflare-supported location hints and documented jurisdictions; the benchmark records the actual observed D1 region from query metadata.
