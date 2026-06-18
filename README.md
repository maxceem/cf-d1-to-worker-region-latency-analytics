# Cloudflare D1-to-Worker Latency Analytics

A D1 query is a round trip, and one request can make many D1 queries. A Worker far from its database stacks up latency fast; Cloudflare placement helps by pinning the Worker near the database.

Worker placement names come from AWS, GCP, and Azure regions, so the fastest Worker location for each D1 region is not always obvious. This benchmark measures the pairings and turns the results into a small static report.

## Run

```bash
CLOUDFLARE_API_TOKEN=... npm run benchmark
```

The default run uses [benchmark.config.json](benchmark.config.json). It benchmarks the D1 locations from [data/d1-locations.json](data/d1-locations.json) against the Worker regions from [data/*-regions.json](data/), then writes results to `results/raw.json`.

Build the report:

```bash
npm run site
```

The report shows the best Worker location per D1 region, the full latency matrix, and ranked per-region details.

## Partial Run

Use [benchmark.config.partial.json](benchmark.config.partial.json) for a smaller targeted run:

```bash
CLOUDFLARE_API_TOKEN=... npm run benchmark -- --config benchmark.config.partial.json
```

To manually choose Worker placements per D1 location, set `workerPlacementsByD1Location`. Object keys are D1 locations; values are the Worker placements to test for that D1 location.

```json
{
  "d1DatabaseNamePrefix": "d1-placement-bench-partial-db",
  "deleteD1DatabasesAfterRun": true,
  "workerPlacementsByD1Location": {
    "enam": ["aws:us-east-1", "gcp:us-east4", "azure:eastus2"],
    "oc": ["aws:ap-southeast-2", "gcp:australia-southeast1", "azure:australiaeast"]
  },
  "maxWorkersPerBatch": 3
}
```

For every other option, check the config files directly.

## Cleanup

Temporary resources are deleted after a normal run. If a run is interrupted and anything is left behind:

```bash
npm run cleanup
```
