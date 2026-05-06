# Benchmark Workflow

`run-benchmark.sh` is the single entrypoint for one repeatable benchmark run from the Jump VM.
Use `run-benchmark-series.sh` when you need repeated runs and run-level statistics for published results.
Use `run-slo-capacity-benchmark.sh` when you want to estimate the highest RPS that still satisfies the k6 SLO thresholds.

It is designed to keep the benchmark start state stable:

1. capture a pre-restore metrics snapshot
2. restore the baseline dump on the DB VM
3. record the restored `"Url"` row count, or verify it when `EXPECTED_URL_COUNT` is set
4. export seed codes from the restored DB
5. wait for the app readiness endpoint
6. smoke-check a few seed codes against `/r/:code`
7. capture a pre-run metrics snapshot
8. run `k6`
9. capture a post-run metrics snapshot
10. save metadata and artifacts under `benchmark-results/`

## What This Script Guarantees

- `k6` does not generate seed data at runtime
- the DB is restored before each benchmark run unless `SKIP_RESTORE=true`
- the restored dataset is checked against `EXPECTED_URL_COUNT`, or against the exported seed count when `EXPECTED_URL_COUNT` is omitted
- the seed file is exported from the restored DB by default and smoke-tested before the load test starts
- benchmark outputs are saved with enough metadata to compare runs later

What it does not do yet:

- scale the app down before restore
- scale the app back up after restore
- run a dedicated warm-up phase before the measured load test

## Required Environment

These are required unless `SKIP_RESTORE=true` and `SEED_FILE` is provided.

- `DB_VM_HOST`: SSH host for the DB VM
- `DB_VM_SSH_KEY`: SSH private key path for the DB VM
- `DB_PGPASSWORD`: PostgreSQL password on the DB VM
- `REMOTE_DUMP_PATH`: dump file path on the DB VM

`run-benchmark.sh` and `run-benchmark-series.sh` automatically load
`~/.config/urlshortener/benchmark.env` when it exists. Keep fixed secrets and
infrastructure values there, outside the repository:

```bash
mkdir -p ~/.config/urlshortener
chmod 700 ~/.config/urlshortener
$EDITOR ~/.config/urlshortener/benchmark.env
chmod 600 ~/.config/urlshortener/benchmark.env
```

Example file:

```bash
export DB_VM_HOST='<db-vm-ip>'
export DB_VM_SSH_KEY="$HOME/.ssh/<db-vm-key>"
export DB_PGPASSWORD='<db-password>'
export DB_NAME='<db-name>'
export REMOTE_DUMP_PATH='/absolute/path/to/baseline.dump'
export TARGET='https://<app-host>'
export LOADTEST_BYPASS_KEY='<loadtest-bypass-key>'
```

Per-run shell assignments still override values from the env file:

```bash
MODE=realistic BASE_RPS=200 SPIKE_MULT=1 ./scripts/run-benchmark-series.sh baseline-4be9c3c
```

## Important Optional Environment

- `DB_VM_USER`: DB VM SSH user. Default: `opc`
- `DB_HOST`: PostgreSQL host on the DB VM. Default: `127.0.0.1`
- `DB_PORT`: PostgreSQL port. Default: `5432`
- `DB_USER`: PostgreSQL user. Default: `postgres`
- `DB_NAME`: PostgreSQL database name. Default: `urlshortener`
- `SEED_FILE`: optional local seed file override on the Jump VM
- `EXPECTED_URL_COUNT`: expected `"Url"` row count after restore. Default: exported seed count
- `SKIP_ROW_COUNT_CHECK`: set to `true` to skip row count validation
- `SEED_SMOKE_SAMPLE_SIZE`: number of seed codes to validate before `k6`. Default: `5`
- `TARGET`: app base URL. Default: `https://141-148-185-116.nip.io`
- `APP_READY_URL`: readiness endpoint. Default: `$TARGET/readyz`
- `APP_METRICS_URL`: metrics endpoint. Default: `$TARGET/metrics`
- `MODE`: `realistic`, `cold`, or `warm`
- `BASE_RPS`: target total RPS
- `SPIKE_MULT`: spike multiplier for realistic mode
- `LOADTEST_DURATION`: optional total k6 scenario duration override
- `REDIRECT_RATIO`: redirect share of total traffic
- `PRE_VUS`: k6 pre-allocated VUs
- `MAX_VUS`: k6 max VUs
- `HOT_SET_PCT`: hot key set percentage
- `HOT_RATIO`: hot key hit ratio
- `BENCHMARK_RUNS`: number of repeated runs for `run-benchmark-series.sh`. Default: `5`

Capacity search variables:

- `CAPACITY_START_RPS`: adaptive search starting RPS. Default: `200`
- `CAPACITY_GROWTH_FACTOR`: adaptive growth factor. Default: `1.5`
- `CAPACITY_MAX_RPS`: adaptive search ceiling. Default: `2000`
- `CAPACITY_MIN_DELTA_RPS`: stop binary search when high-low is at most this. Default: `50`
- `CAPACITY_RPS_LEVELS`: optional manual space-separated RPS candidates
- `SEARCH_RUNS`: runs per search candidate. Default: `1`
- `CONFIRM_RUNS`: runs per confirmation candidate. Default: `3`
- `CAPACITY_SEARCH_DURATION`: search `LOADTEST_DURATION`. Default: `60s`
- `CAPACITY_CONFIRM_DURATION`: confirmation `LOADTEST_DURATION`. Default: `120s`
- `CAPACITY_DRY_RUN`: set to `true` to test candidate selection and artifact generation without running benchmarks

## Environment-Specific Values

Do not commit real infrastructure values into this file.

Keep these values local to the Jump VM or your shell session:

- `DB_VM_HOST`
- `DB_VM_SSH_KEY`
- `DB_PGPASSWORD`
- `DB_NAME`
- `REMOTE_DUMP_PATH`
- `TARGET`
- `LOADTEST_BYPASS_KEY`

## Example: Baseline Run

```bash
DB_VM_HOST='<db-vm-ip>' \
DB_VM_SSH_KEY="$HOME/.ssh/<db-vm-key>" \
DB_PGPASSWORD='<db-password>' \
DB_NAME='<db-name>' \
REMOTE_DUMP_PATH='/absolute/path/to/baseline.dump' \
TARGET='https://<app-host>' \
LOADTEST_BYPASS_KEY='<loadtest-bypass-key>' \
BASE_RPS=200 \
MODE=realistic \
./scripts/run-benchmark.sh realistic-200rps
```

## Example: Repeated Series

Use this for numbers you plan to publish. The series wrapper runs the same benchmark repeatedly,
continues after k6 threshold failures, aborts repeated setup failures, and writes aggregate statistics after all runs finish.

```bash
DB_VM_HOST='<db-vm-ip>' \
DB_VM_SSH_KEY="$HOME/.ssh/<db-vm-key>" \
DB_PGPASSWORD='<db-password>' \
DB_NAME='<db-name>' \
REMOTE_DUMP_PATH='/absolute/path/to/baseline.dump' \
TARGET='https://<app-host>' \
LOADTEST_BYPASS_KEY='<loadtest-bypass-key>' \
BASE_RPS=450 \
SPIKE_MULT=1 \
MODE=realistic \
BENCHMARK_RUNS=5 \
./scripts/run-benchmark-series.sh steady-450rps-public
```

The wrapper creates:

- `benchmark-results/steady-450rps-public-r01/` through `r05/`
- `benchmark-results/steady-450rps-public-series/series-summary.md` when `node` is available
- `benchmark-results/steady-450rps-public-series/series-summary.json` when `node` is available

Install Node.js on the Jump VM when you need aggregate series summaries there.
Without Node.js, the wrapper still runs the benchmark series and records run directories plus exit codes.

The aggregate table uses only valid runs:

- `K6_EXIT_CODE` is `0` when present
- global `dropped_iterations` is `0`
- `http_req_failed` is below `1%`
- endpoint success rates are above `99%`

If all runs are invalid, the summary still reports diagnostic aggregates but those numbers should not be published as passing results.

## Example: SLO Capacity Benchmark

Use this when the headline result is maximum RPS while preserving SLOs. The capacity wrapper reuses
`run-benchmark-series.sh`, starts at `CAPACITY_START_RPS`, grows until a failure or `CAPACITY_MAX_RPS`,
then searches inside the pass/fail bracket and confirms the highest passing candidate.

```bash
MODE=realistic \
SPIKE_MULT=1 \
CAPACITY_START_RPS=200 \
CAPACITY_MAX_RPS=2000 \
./scripts/run-slo-capacity-benchmark.sh latest-e28185c
```

For capacity reporting, prefer `SPIKE_MULT=1` so `BASE_RPS` means sustained target RPS.
If you intentionally keep a spike multiplier, report both `BASE_RPS` and effective peak RPS.

The default runtime profile is:

- search: `SEARCH_RUNS=1`, `CAPACITY_SEARCH_DURATION=60s`
- confirmation: `CONFIRM_RUNS=3`, `CAPACITY_CONFIRM_DURATION=120s`

The wrapper creates:

- `benchmark-results/latest-e28185c-capacity/capacity-summary.md`
- `benchmark-results/latest-e28185c-capacity/capacity-summary.json`
- `benchmark-results/latest-e28185c-capacity/runs/` for the underlying benchmark series artifacts

Manual candidate mode is available when you already know the range:

```bash
MODE=realistic \
SPIKE_MULT=1 \
CAPACITY_RPS_LEVELS="400 600 800 1000" \
./scripts/run-slo-capacity-benchmark.sh latest-e28185c
```

Dry-run mode validates the search logic and summary output without DB, target, or secret values:

```bash
CAPACITY_DRY_RUN=true \
CAPACITY_DRY_RUN_PASS_UNTIL_RPS=900 \
./scripts/run-slo-capacity-benchmark.sh dry-latest
```

## Example: Smoke Run

Use this first after changing the app image or dump.

```bash
DB_VM_HOST='<db-vm-ip>' \
DB_VM_SSH_KEY="$HOME/.ssh/<db-vm-key>" \
DB_PGPASSWORD='<db-password>' \
DB_NAME='<db-name>' \
REMOTE_DUMP_PATH='/absolute/path/to/baseline.dump' \
TARGET='https://<app-host>' \
LOADTEST_BYPASS_KEY='<loadtest-bypass-key>' \
BASE_RPS=50 \
MODE=realistic \
./scripts/run-benchmark.sh smoke-50rps
```

## Example: Skip Restore

Only use this when you are certain the DB is already in the correct baseline state.
If you omit `SEED_FILE`, the script still needs DB VM access so it can export seed codes from the live dataset.

```bash
DB_NAME='<db-name>' \
TARGET='https://<app-host>' \
LOADTEST_BYPASS_KEY='<loadtest-bypass-key>' \
SKIP_RESTORE=true \
BASE_RPS=200 \
MODE=realistic \
./scripts/run-benchmark.sh no-restore-200rps
```

## Output Artifacts

Each run creates a directory under `benchmark-results/<run-label>/`.

Important files:

- `run-metadata.env`: run parameters and derived values
- `git-status.txt`: local uncommitted changes at run time, if any
- `seed_codes.generated.json`: seed codes exported from the restored DB unless `SEED_FILE` override is used
- `k6-summary.json`: machine-readable summary
  - includes `p(99)` because `summaryTrendStats` is set in `scripts/loadtest.js`
  - does not include `setup_data`, so seed codes are not stored in the summary artifact
- `k6-output.log`: raw `k6` console output
- `metrics-pre-restore.prom`: app metrics before DB restore
- `metrics-pre-run.prom`: app metrics after readiness and smoke checks
- `metrics-post-run.prom`: app metrics after the load test
- `artifacts.txt`: list of generated files

If `k6` exits non-zero because thresholds fail, the script still captures:

- `k6-summary.json`
- `k6-output.log`
- `metrics-post-run.prom`
- `K6_EXIT_CODE` in `run-metadata.env`

## Failure Modes

If the script fails before `k6` starts, check these first:

- `seed file not found`
  - verify the optional `SEED_FILE` override on the Jump VM

- `restored row count mismatch`
  - confirm the correct dump path and expected row count

- `app did not become ready`
  - check the app pods, ingress, and `/readyz`

- `seed validation failed for code ... expected 302`
  - the app is serving the wrong database/state
  - or the export/readiness order is racing with an incomplete rollout

- `failed to capture metrics snapshot`
  - verify `$TARGET/metrics`

If `k6` starts but results look wrong, check:

- `http_req_failed`
- `redirect_success_rate`
- `shorten_success_rate`
- `dropped_iterations`
- Grafana panels for app and PostgreSQL

## Reproducible Reporting

For public claims, do not report a single run as the result. Report run-level aggregates from a repeated series.

Recommended minimums:

- LinkedIn or project write-up: at least `5` runs per condition
- more formal write-up: `10+` runs per condition, with raw artifacts kept

Report at least:

- app git SHA
- dataset size and seed source
- target RPS and achieved req/s
- traffic mix, `MODE`, `HOT_SET_PCT`, and `HOT_RATIO`
- p95 and p99 latency for redirect and shorten
- `http_req_failed`
- global `dropped_iterations`
- number of valid runs and excluded runs

Prefer median and IQR for latency percentiles, and include mean and sample standard deviation as secondary context.

For capacity claims, use `capacity-summary.md` as the headline source:

- report the confirmed SLO capacity RPS
- include whether the result was capped by `CAPACITY_MAX_RPS`
- include `MODE`, `SPIKE_MULT`, `REDIRECT_RATIO`, dataset size, and app git SHA
- keep p95, p99, error rate, and dropped iterations as supporting evidence from the confirmed series

## Operational Notes

- Keep the dump file on the DB VM for simplicity and repeatability.
- Let the benchmark script export the seed file from the restored DB so the dataset stays self-consistent.
- Do not change the app image, replica count, or benchmark parameters mid-series if you want comparable numbers.
- For published results, record the app git SHA, target RPS, achieved RPS, p95, p99, error rate, dropped iterations, number of repeated runs, and the main bottleneck you observed.

## Recommended Breakpoint Runs

When the realistic profile is failing hard, find the breakpoint with steady runs first.

```bash
DB_VM_HOST='<db-vm-ip>' \
DB_VM_SSH_KEY="$HOME/.ssh/<db-vm-key>" \
DB_PGPASSWORD='<db-password>' \
DB_NAME='<db-name>' \
REMOTE_DUMP_PATH='/absolute/path/to/baseline.dump' \
TARGET='https://<app-host>' \
LOADTEST_BYPASS_KEY='<loadtest-bypass-key>' \
SPIKE_MULT=1 \
BASE_RPS=100 \
MODE=realistic \
./scripts/run-benchmark.sh steady-100rps
```

Repeat at `BASE_RPS=150`, then `200`, and compare `K6_EXIT_CODE`, `http_req_failed`, `redirect_success_rate`, `shorten_success_rate`, and `metrics-post-run.prom`.

For publishable SLO capacity numbers, prefer `run-slo-capacity-benchmark.sh` over manual breakpoint stepping.
