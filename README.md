# Cloudflare D1-to-Worker Latency Analytics

When a user calls a Cloudflare Worker that queries a D1 database, D1 round trips can add latency to the final response, especially when a request runs multiple sequential D1 queries.

This benchmark measures the latency between D1 and a Worker when that Worker is pinned to a specific third-party cloud region, such as AWS, GCP, or Azure, using Cloudflare's [`region` placement configuration](https://developers.cloudflare.com/workers/configuration/placement/#specify-a-cloud-region).

### Best worker location per D1 region (p50)

[View full analytics report](https://maxceem.github.io/cf-d1-to-worker-region-latency-analytics/)

![](./images/site-screenshot.png)

## Run

```bash
CLOUDFLARE_API_TOKEN=... npm run benchmark
```

The default run uses [benchmark.config.json](benchmark.config.json). It benchmarks all the D1 locations from [data/d1-locations.json](data/d1-locations.json) against all the Worker regions from [data/*-regions.json](data/). Each discovery wave tries to find one new D1 colocation per D1 location, retrying already tested colocations until `databaseDiscoveryAttemptsPerRegion` is exhausted for that location. Newly observed D1 colocations are benchmarked against every Worker batch, then results are written under `results/<date-time>/raw.json`, the static report is built, and opened.

Resume an incomplete run by passing its results folder:

```bash
CLOUDFLARE_API_TOKEN=... npm run benchmark -- --resume results/2026-06-22_10-14-03_UTC
```

The `CLOUDFLARE_API_TOKEN` needs these account permissions:

- `D1:Edit`
- `Workers Scripts:Edit`
- `Account Settings:Read` if you do not set `accountId` in config or `CLOUDFLARE_ACCOUNT_ID`

## Partial Run

If you want to test only particular pairs of D1 and Worker regions, use [benchmark.config.partial.json](benchmark.config.partial.json) as a starting point.

Set `workerPlacementsByD1Location`. Object keys are D1 locations; values are the Worker placements to test for that D1 location.

```json
{
  "workerPlacementsByD1Location": {
    "enam": ["aws:us-east-1", "gcp:us-east4", "azure:eastus2"],
    "oc": ["aws:ap-southeast-2", "gcp:australia-southeast1", "azure:australiaeast"]
  }
}
```

And then run benchmark using partial config:

```bash
CLOUDFLARE_API_TOKEN=... npm run benchmark -- --config benchmark.config.partial.json
```

## Worker Region Finder

Use the finder to benchmark Worker placements for an existing D1 database. It observes the D1 region, selects Worker placements from [data/finder/d1-provider-region-map.json](data/finder/d1-provider-region-map.json), writes results under `results-finder/<database-name>-<date-time>`, builds the report in that run folder under `site`, and opens it.

```bash
CLOUDFLARE_API_TOKEN=... npm run finder -- --database-name "repostic-app-db-wnam"
```

The default finder config is [worker-region-finder.config.json](worker-region-finder.config.json).

Use `--no-site` to skip report generation, or `--no-open` to build the report without opening it.

## Cleanup

Temporary resources are deleted after a normal run. If a run is interrupted and anything is left behind, clean up any stale resources with:

```bash
npm run cleanup
```

Preview tracked resources without deleting them:

```bash
npm run cleanup -- --dry-run
```

Clean up only finder resources:

```bash
npm run cleanup -- finder
```

## License

MIT
