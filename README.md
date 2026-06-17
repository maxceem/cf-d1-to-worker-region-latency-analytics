# D1 Placement Benchmark

One command creates benchmark D1 databases, deploys temporary benchmark Workers with targeted Cloudflare placement in batches, measures Worker-to-D1 latency inside each Worker, writes reports, and removes temporary resources.

## Quick run with a disposable D1 database

```bash
CLOUDFLARE_API_TOKEN=... npm run benchmark
```

The default run creates one temporary D1 database for each configured D1 location hint, seeds a small table in each, tests every configured Worker placement against every D1 database, writes `results/raw.json`, `results/summary.json`, and `results/report.md`, then deletes the temporary Workers and D1 databases.

Workers are deployed in batches. The default cap is 50 Workers at a time:

```json
{
  "maxWorkersPerBatch": 50
}
```

During the run, progress is continuously written to:

```text
results/raw.partial.json
results/summary.partial.json
results/report.partial.md
```

## Benchmark an existing D1 database

```bash
cp benchmark.config.example.json benchmark.config.json
CLOUDFLARE_API_TOKEN=... npm run benchmark -- --config benchmark.config.json
```

`accountId` is optional when the token can list exactly one Cloudflare account. If your token can access multiple accounts, set either `accountId` in the config or `CLOUDFLARE_ACCOUNT_ID`.

To reduce the matrix, edit `benchmark.config.json`. For example:

```json
{
  "database": {
    "mode": "new-db",
    "locations": ["enam", "wnam"]
  },
  "candidateProviders": ["aws"],
  "candidatePlacements": ["gcp:us-central1", "azure:eastus2"],
  "maxWorkersPerBatch": 20
}
```

`candidateProviders` expands from `aws-regions.json`, `gcp-regions.json`, and `azure-regions.json`. `candidatePlacements` adds explicit placements on top.

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
npm run benchmark -- --keep-workers
npm run benchmark -- --keep-database
npm run benchmark -- --results-dir custom-results
```

D1 exact provider-region pinning is not exposed. D1 creation accepts only Cloudflare-supported location hints and documented jurisdictions; the benchmark records the actual observed D1 region from query metadata.
