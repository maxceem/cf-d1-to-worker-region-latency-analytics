# D1 Placement Benchmark Spec

## Goal

Build a Cloudflare benchmarking tool that finds the best Worker placement region for a given D1 database region.

The tool should:

1. Create or accept a D1 database.
2. Detect the D1 database's actual Cloudflare region, for example `ENAM`.
3. Deploy benchmark Workers with explicit `placement.region` values across configured AWS, GCP, and Azure regions.
4. Run repeated D1 queries through each Worker.
5. Collect server-side latency metrics for Worker-to-D1 round trips.
6. Produce a ranked report recommending the best Worker placement region.

## Important Platform Constraints

D1 exact region selection is not currently exposed as an arbitrary enum. Do not assume the tool can create D1 in `us-east-1`, `us-west-2`, or similar provider regions.

Cloudflare supports D1 jurisdiction at creation time, currently documented for jurisdictions such as `eu` and `fedramp`. Jurisdiction cannot be changed after creation.

Therefore, the tool should support two modes:

`existing-db` mode:
Use an existing D1 database ID/name, inspect its actual `running_in_region`, and benchmark Worker regions against it.

`new-db` mode:
Create a disposable D1 database, optionally with a supported jurisdiction, inspect its actual `running_in_region`, run benchmarks, then optionally delete it.

Cloudflare docs reference: [D1 can restrict data localization with jurisdictions](https://developers.cloudflare.com/changelog/post/2025-11-05-d1-jurisdiction/).

## Inputs

Use a JSON config file like:

```json
{
  "accountId": "...",
  "database": {
    "mode": "existing-db",
    "name": "repostic-app-db"
  },
  "workerNamePrefix": "d1-placement-bench",
  "candidatePlacements": [
    "aws:us-east-1",
    "aws:us-east-2",
    "aws:us-west-2",
    "gcp:us-east1",
    "gcp:us-central1",
    "azure:eastus",
    "azure:eastus2"
  ],
  "benchmark": {
    "warmupRequests": 10,
    "measuredRequests": 100,
    "queriesPerRequest": 5,
    "concurrency": 5
  }
}
```

## Benchmark Worker

Generate and deploy one Worker per candidate placement.

Each Worker should:

1. Bind to the benchmark D1 database.
2. Expose `GET /bench`.
3. Run a fixed set of simple D1 queries.
4. Measure timings inside the Worker using `performance.now()`.
5. Return JSON with placement and timing details.

Example response:

```json
{
  "workerPlacement": "aws:us-east-1",
  "workerColo": "MRS",
  "queries": 5,
  "totalMs": 212.4,
  "perQueryMs": [41.8, 42.1, 43.0, 41.5, 44.0]
}
```

Start with simple benchmark queries:

```sql
SELECT 1;
SELECT COUNT(*) FROM bench_items;
SELECT * FROM bench_items WHERE id = ?;
```

Create and seed a small benchmark table before running tests.

## Deployment

For each candidate placement, generate a Wrangler config with:

```jsonc
{
  "name": "d1-placement-bench-aws-us-east-1",
  "main": "src/worker.ts",
  "compatibility_date": "2026-06-17",
  "placement": {
    "region": "aws:us-east-1"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "...",
      "database_id": "..."
    }
  ]
}
```

Deploy all Workers, wait briefly for propagation, then run warmup and measured requests.

## Metrics

For each placement, compute:

- request count
- error count
- average Worker-measured DB time
- p50
- p90
- p95
- p99
- min
- max
- standard deviation
- average per-query latency
- Cloudflare colo observed by request headers or Worker request metadata, if available

If credentials and telemetry access are available, also query Cloudflare Observability after the run to enrich results with:

- `faas.invoked_region`
- `cloudflare.d1.response.served_by_region`
- `cloudflare.d1.response.sql_duration_ms`
- D1 span duration
- script version

## Output

Write:

1. `results/raw.json`
2. `results/summary.json`
3. `results/report.md`

Report format:

```md
# D1 Placement Benchmark

D1 database: repostic-app-db
D1 observed region: ENAM
Run time: ...

## Ranking

| Rank | Placement | Avg | p50 | p90 | p95 | p99 | Errors |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | aws:us-east-1 | 42ms | 38ms | 48ms | 58ms | 75ms | 0 |
| 2 | aws:us-east-2 | 46ms | 41ms | 62ms | 73ms | 90ms | 0 |

## Recommendation

Use `aws:us-east-1` for this D1 database because it has the lowest p95 and stable average latency.
```

## Acceptance Criteria

The tool must:

- Work with an existing D1 database.
- Optionally create a disposable benchmark D1 database.
- Detect and record actual D1 `running_in_region`.
- Deploy one Worker per configured placement.
- Run warmup separately from measured requests.
- Produce ranked JSON and Markdown reports.
- Clean up benchmark Workers.
- Optionally clean up disposable D1 databases.
- Avoid modifying production app configs.
- Clearly warn that D1 exact region pinning is not supported except documented jurisdiction options.

## Recommended Implementation

Use Node.js/TypeScript.

Suggested command/API operations:

- `wrangler d1 info`
- `wrangler d1 create`
- `wrangler d1 execute`
- `wrangler deploy`
- Cloudflare REST API or Wrangler for cleanup

The key design point is to benchmark Worker-to-D1 latency from inside the Worker, not browser-to-Worker latency. Browser timings mix client distance, Cloudflare routing, Worker placement, and D1 latency, which makes the result harder to interpret.
