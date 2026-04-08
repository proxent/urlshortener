# Benchmark Workflow

`run-benchmark.sh` is the single entrypoint for repeatable benchmark runs from the Jump VM.

It is designed to keep the benchmark start state stable:

1. capture a pre-restore metrics snapshot
2. restore the baseline dump on the DB VM
3. verify the restored `"Url"` row count
4. wait for the app readiness endpoint
5. smoke-check a few seed codes against `/r/:code`
6. capture a pre-run metrics snapshot
7. run `k6`
8. capture a post-run metrics snapshot
9. save metadata and artifacts under `benchmark-results/`

## What This Script Guarantees

- `k6` does not generate seed data at runtime
- the DB is restored before each benchmark run unless `SKIP_RESTORE=true`
- the restored dataset is checked against the expected row count
- the seed file is smoke-tested before the load test starts
- benchmark outputs are saved with enough metadata to compare runs later

What it does not do yet:

- scale the app down before restore
- scale the app back up after restore
- run a dedicated warm-up phase before the measured load test

## Required Environment

These are required unless `SKIP_RESTORE=true`.

- `DB_VM_HOST`: SSH host for the DB VM
- `DB_VM_SSH_KEY`: SSH private key path for the DB VM
- `DB_PGPASSWORD`: PostgreSQL password on the DB VM
- `REMOTE_DUMP_PATH`: dump file path on the DB VM

## Important Optional Environment

- `DB_VM_USER`: DB VM SSH user. Default: `opc`
- `DB_HOST`: PostgreSQL host on the DB VM. Default: `127.0.0.1`
- `DB_PORT`: PostgreSQL port. Default: `5432`
- `DB_USER`: PostgreSQL user. Default: `postgres`
- `DB_NAME`: PostgreSQL database name. Default: `urlshortener`
- `SEED_FILE`: local seed file on the Jump VM. Default: `scripts/seed_codes.json`
- `EXPECTED_URL_COUNT`: expected `"Url"` row count after restore. Default: seed file length
- `SKIP_ROW_COUNT_CHECK`: set to `true` to skip row count validation
- `SEED_SMOKE_SAMPLE_SIZE`: number of seed codes to validate before `k6`. Default: `5`
- `TARGET`: app base URL. Default: `https://141-148-185-116.nip.io`
- `APP_READY_URL`: readiness endpoint. Default: `$TARGET/readyz`
- `APP_METRICS_URL`: metrics endpoint. Default: `$TARGET/metrics`
- `MODE`: `realistic`, `cold`, or `warm`
- `BASE_RPS`: target total RPS
- `SPIKE_MULT`: spike multiplier for realistic mode
- `REDIRECT_RATIO`: redirect share of total traffic
- `PRE_VUS`: k6 pre-allocated VUs
- `MAX_VUS`: k6 max VUs
- `HOT_SET_PCT`: hot key set percentage
- `HOT_RATIO`: hot key hit ratio

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
- `SEED_FILE`

## Example: Baseline Run

```bash
DB_VM_HOST='<db-vm-ip>' \
DB_VM_SSH_KEY="$HOME/.ssh/<db-vm-key>" \
DB_PGPASSWORD='<db-password>' \
DB_NAME='<db-name>' \
REMOTE_DUMP_PATH='/absolute/path/to/baseline.dump' \
TARGET='https://<app-host>' \
SEED_FILE="$PWD/scripts/seed_codes.json" \
LOADTEST_BYPASS_KEY='<loadtest-bypass-key>' \
BASE_RPS=200 \
MODE=realistic \
./scripts/run-benchmark.sh realistic-200rps
```

## Example: Smoke Run

Use this first after changing the app image, seed file, or dump.

```bash
DB_VM_HOST='<db-vm-ip>' \
DB_VM_SSH_KEY="$HOME/.ssh/<db-vm-key>" \
DB_PGPASSWORD='<db-password>' \
DB_NAME='<db-name>' \
REMOTE_DUMP_PATH='/absolute/path/to/baseline.dump' \
TARGET='https://<app-host>' \
SEED_FILE="$PWD/scripts/seed_codes.json" \
LOADTEST_BYPASS_KEY='<loadtest-bypass-key>' \
BASE_RPS=50 \
MODE=realistic \
./scripts/run-benchmark.sh smoke-50rps
```

## Example: Skip Restore

Only use this when you are certain the DB is already in the correct baseline state.

```bash
DB_NAME='<db-name>' \
TARGET='https://<app-host>' \
SEED_FILE="$PWD/scripts/seed_codes.json" \
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
- `k6-summary.json`: machine-readable summary
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
  - verify `SEED_FILE` on the Jump VM

- `restored row count mismatch`
  - the dump and seed file likely do not belong to the same dataset
  - confirm the correct dump path and seed file

- `app did not become ready`
  - check the app pods, ingress, and `/readyz`

- `seed validation failed for code ... expected 302`
  - the restored DB does not match the seed file
  - or the app is serving the wrong database/state

- `failed to capture metrics snapshot`
  - verify `$TARGET/metrics`

If `k6` starts but results look wrong, check:

- `http_req_failed`
- `redirect_success_rate`
- `shorten_success_rate`
- `dropped_iterations`
- Grafana panels for app and PostgreSQL

## Operational Notes

- Keep the dump file on the DB VM for simplicity and repeatability.
- Keep `seed_codes.json` on the Jump VM and update it together with the dump.
- Do not change the app image, replica count, or benchmark parameters mid-series if you want comparable numbers.
- For published results, record the app git SHA, target RPS, p95, p99, error rate, and the main bottleneck you observed.

## Recommended Breakpoint Runs

When the realistic profile is failing hard, find the breakpoint with steady runs first.

```bash
DB_VM_HOST='<db-vm-ip>' \
DB_VM_SSH_KEY="$HOME/.ssh/<db-vm-key>" \
DB_PGPASSWORD='<db-password>' \
DB_NAME='<db-name>' \
REMOTE_DUMP_PATH='/absolute/path/to/baseline.dump' \
TARGET='https://<app-host>' \
SEED_FILE="$PWD/scripts/seed_codes.json" \
LOADTEST_BYPASS_KEY='<loadtest-bypass-key>' \
SPIKE_MULT=1 \
BASE_RPS=100 \
MODE=realistic \
./scripts/run-benchmark.sh steady-100rps
```

Repeat at `BASE_RPS=150`, then `200`, and compare `K6_EXIT_CODE`, `http_req_failed`, `redirect_success_rate`, `shorten_success_rate`, and `metrics-post-run.prom`.
