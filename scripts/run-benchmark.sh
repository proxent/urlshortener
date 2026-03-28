#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "${SCRIPT_DIR}/.." && pwd)

usage() {
  cat <<'EOF'
Usage:
  DB_VM_HOST='...' DB_VM_SSH_KEY='...' DB_PGPASSWORD='...' REMOTE_DUMP_PATH='/tmp/urlshortener-baseline.dump' ./scripts/run-benchmark.sh [run-label]

Required environment:
  DB_VM_HOST      DB VM SSH host
  DB_VM_SSH_KEY   SSH private key path for the DB VM
  DB_PGPASSWORD   PostgreSQL password on the DB VM
  REMOTE_DUMP_PATH  Dump path on the DB VM

Optional environment:
  TARGET            App base URL for k6 (default: https://141-148-185-116.nip.io)
  APP_READY_URL     Readiness endpoint (default: $TARGET/readyz)
  APP_METRICS_URL   Metrics endpoint (default: $TARGET/metrics)
  DB_VM_USER        DB VM SSH user (default: opc)
  DB_HOST           PostgreSQL host on the DB VM (default: 127.0.0.1)
  DB_PORT           PostgreSQL port (default: 5432)
  DB_USER           PostgreSQL user (default: postgres)
  DB_NAME           PostgreSQL database name (default: urlshortener)
  RESET_SCHEMA      Reset public schema before restore (default: true)
  SKIP_RESTORE      Skip the remote restore step (default: false)
  SEED_FILE         Local seed file for k6 (default: scripts/seed_codes.json)
  LOADTEST_BYPASS_KEY  Bypass key for /shorten (default: bypass)
  MODE              k6 mode: realistic|cold|warm (default: realistic)
  BASE_RPS          Total target RPS (default: 500)
  SPIKE_MULT        Spike multiplier (default: 3)
  REDIRECT_RATIO    Redirect traffic ratio (default: 0.98)
  PRE_VUS           k6 pre-allocated VUs (default: 200)
  MAX_VUS           k6 max VUs (default: 2000)
  HOT_SET_PCT       Hot key set percentage (default: 0.01)
  HOT_RATIO         Hot key hit ratio (default: 0.6)
  RESULTS_BASE_DIR  Where to store outputs (default: benchmark-results/)
  WAIT_READY_TIMEOUT_SEC   Readiness timeout in seconds (default: 180)
  WAIT_READY_INTERVAL_SEC  Readiness polling interval in seconds (default: 5)
  CAPTURE_METRICS_SNAPSHOT Save pre/post metrics snapshots (default: true)
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

TARGET=${TARGET:-https://141-148-185-116.nip.io}
TARGET=${TARGET%/}
APP_READY_URL=${APP_READY_URL:-${TARGET}/readyz}
APP_METRICS_URL=${APP_METRICS_URL:-${TARGET}/metrics}

DB_VM_HOST=${DB_VM_HOST:-}
DB_VM_USER=${DB_VM_USER:-opc}
DB_VM_SSH_KEY=${DB_VM_SSH_KEY:-}
REMOTE_DUMP_PATH=${REMOTE_DUMP_PATH:-}

DB_HOST=${DB_HOST:-127.0.0.1}
DB_PORT=${DB_PORT:-5432}
DB_USER=${DB_USER:-postgres}
DB_NAME=${DB_NAME:-urlshortener}
DB_PGPASSWORD=${DB_PGPASSWORD:-}
RESET_SCHEMA=${RESET_SCHEMA:-true}
SKIP_RESTORE=${SKIP_RESTORE:-false}

SEED_FILE=${SEED_FILE:-${REPO_ROOT}/scripts/seed_codes.json}
LOADTEST_BYPASS_KEY=${LOADTEST_BYPASS_KEY:-bypass}

MODE=${MODE:-realistic}
BASE_RPS=${BASE_RPS:-500}
SPIKE_MULT=${SPIKE_MULT:-3}
REDIRECT_RATIO=${REDIRECT_RATIO:-0.98}
PRE_VUS=${PRE_VUS:-200}
MAX_VUS=${MAX_VUS:-2000}
HOT_SET_PCT=${HOT_SET_PCT:-0.01}
HOT_RATIO=${HOT_RATIO:-0.6}

RESULTS_BASE_DIR=${RESULTS_BASE_DIR:-${REPO_ROOT}/benchmark-results}
WAIT_READY_TIMEOUT_SEC=${WAIT_READY_TIMEOUT_SEC:-180}
WAIT_READY_INTERVAL_SEC=${WAIT_READY_INTERVAL_SEC:-5}
CAPTURE_METRICS_SNAPSHOT=${CAPTURE_METRICS_SNAPSHOT:-true}

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
RUN_LABEL=${1:-${MODE}-${BASE_RPS}rps-${timestamp}}
RESULT_DIR="${RESULTS_BASE_DIR}/${RUN_LABEL}"
RUN_METADATA_FILE="${RESULT_DIR}/run-metadata.env"
GIT_STATUS_FILE="${RESULT_DIR}/git-status.txt"
K6_SUMMARY_FILE="${RESULT_DIR}/k6-summary.json"
K6_LOG_FILE="${RESULT_DIR}/k6-output.log"
METRICS_PRE_RESTORE_FILE="${RESULT_DIR}/metrics-pre-restore.prom"
METRICS_PRE_RUN_FILE="${RESULT_DIR}/metrics-pre-run.prom"
METRICS_POST_RUN_FILE="${RESULT_DIR}/metrics-post-run.prom"
ARTIFACTS_FILE="${RESULT_DIR}/artifacts.txt"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[benchmark] required command not found: $1" >&2
    exit 1
  fi
}

quote() {
  printf '%q' "$1"
}

require_command ssh
require_command curl
require_command git

if ! command -v k6 >/dev/null 2>&1 && ! command -v docker >/dev/null 2>&1; then
  echo "[benchmark] either k6 or docker must be installed on the jump VM" >&2
  exit 1
fi

if [ "$SKIP_RESTORE" != "true" ]; then
  if [ -z "$DB_VM_HOST" ]; then
    echo "[benchmark] DB_VM_HOST is required unless SKIP_RESTORE=true" >&2
    exit 1
  fi

  if [ -z "$DB_VM_SSH_KEY" ]; then
    echo "[benchmark] DB_VM_SSH_KEY is required unless SKIP_RESTORE=true" >&2
    exit 1
  fi

  if [ -z "$DB_PGPASSWORD" ]; then
    echo "[benchmark] DB_PGPASSWORD is required unless SKIP_RESTORE=true" >&2
    exit 1
  fi

  if [ -z "$REMOTE_DUMP_PATH" ]; then
    echo "[benchmark] REMOTE_DUMP_PATH is required unless SKIP_RESTORE=true" >&2
    exit 1
  fi
fi

if [ ! -f "$SEED_FILE" ]; then
  echo "[benchmark] seed file not found: $SEED_FILE" >&2
  exit 1
fi

mkdir -p "$RESULT_DIR"

git_sha=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)
git_status=$(git -C "$REPO_ROOT" status --short 2>/dev/null || true)

write_metadata() {
  cat > "${RUN_METADATA_FILE}" <<EOF
RUN_LABEL=${RUN_LABEL}
STARTED_AT_UTC=${timestamp}
TARGET=${TARGET}
APP_READY_URL=${APP_READY_URL}
APP_METRICS_URL=${APP_METRICS_URL}
DB_VM_HOST=${DB_VM_HOST}
DB_VM_USER=${DB_VM_USER}
REMOTE_DUMP_PATH=${REMOTE_DUMP_PATH}
DB_HOST=${DB_HOST}
DB_PORT=${DB_PORT}
DB_USER=${DB_USER}
DB_NAME=${DB_NAME}
RESET_SCHEMA=${RESET_SCHEMA}
SKIP_RESTORE=${SKIP_RESTORE}
SEED_FILE=${SEED_FILE}
LOADTEST_BYPASS_KEY=${LOADTEST_BYPASS_KEY}
MODE=${MODE}
BASE_RPS=${BASE_RPS}
SPIKE_MULT=${SPIKE_MULT}
REDIRECT_RATIO=${REDIRECT_RATIO}
PRE_VUS=${PRE_VUS}
MAX_VUS=${MAX_VUS}
HOT_SET_PCT=${HOT_SET_PCT}
HOT_RATIO=${HOT_RATIO}
GIT_SHA=${git_sha}
EOF

  if [ -n "$git_status" ]; then
    printf '%s\n' "$git_status" > "${GIT_STATUS_FILE}"
  fi

  cat > "${ARTIFACTS_FILE}" <<EOF
${RUN_METADATA_FILE}
${GIT_STATUS_FILE}
${K6_SUMMARY_FILE}
${K6_LOG_FILE}
${METRICS_PRE_RESTORE_FILE}
${METRICS_PRE_RUN_FILE}
${METRICS_POST_RUN_FILE}
EOF
}

metrics_snapshot_path() {
  case "$1" in
    pre-restore) printf '%s\n' "$METRICS_PRE_RESTORE_FILE" ;;
    pre-run) printf '%s\n' "$METRICS_PRE_RUN_FILE" ;;
    post-run) printf '%s\n' "$METRICS_POST_RUN_FILE" ;;
    *)
      echo "[benchmark] unknown metrics snapshot name: $1" >&2
      exit 1
      ;;
  esac
}

append_metadata() {
  {
    printf '%s=%s\n' "$1" "$2"
  } >> "${RUN_METADATA_FILE}"
}

finalize_metadata() {
  local finished_at
  finished_at=$(date -u +%Y%m%dT%H%M%SZ)

  append_metadata "FINISHED_AT_UTC" "$finished_at"
  append_metadata "RESULT_DIR" "$RESULT_DIR"
}

run_benchmark() {
  if command -v k6 >/dev/null 2>&1; then
    run_k6_local
  else
    run_k6_docker
  fi
}

restore_remote_db() {
  echo "[benchmark] restoring dump on ${DB_VM_USER}@${DB_VM_HOST}:${REMOTE_DUMP_PATH}"

  local remote_cmd
  remote_cmd=$(
    cat <<EOF
PGPASSWORD=$(quote "$DB_PGPASSWORD") \
PGHOST=$(quote "$DB_HOST") \
PGPORT=$(quote "$DB_PORT") \
PGUSER=$(quote "$DB_USER") \
PGDATABASE=$(quote "$DB_NAME") \
RESET_SCHEMA=$(quote "$RESET_SCHEMA") \
bash -s -- $(quote "$REMOTE_DUMP_PATH")
EOF
  )

  ssh \
    -i "$DB_VM_SSH_KEY" \
    -o StrictHostKeyChecking=no \
    "${DB_VM_USER}@${DB_VM_HOST}" \
    "$remote_cmd" \
    < "${REPO_ROOT}/scripts/restore-db.sh"
}

wait_for_ready() {
  local deadline=$((SECONDS + WAIT_READY_TIMEOUT_SEC))

  echo "[benchmark] waiting for app readiness at ${APP_READY_URL}"

  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 5 "$APP_READY_URL" >/dev/null 2>&1; then
      echo "[benchmark] app is ready"
      return 0
    fi

    sleep "$WAIT_READY_INTERVAL_SEC"
  done

  echo "[benchmark] app did not become ready within ${WAIT_READY_TIMEOUT_SEC}s" >&2
  exit 1
}

capture_metrics_snapshot() {
  local snapshot_name=$1

  if [ "$CAPTURE_METRICS_SNAPSHOT" != "true" ]; then
    return 0
  fi

  local snapshot_path
  snapshot_path=$(metrics_snapshot_path "$snapshot_name")

  if ! curl -fsS --max-time 10 "$APP_METRICS_URL" > "${snapshot_path}"; then
    echo "[benchmark] warning: failed to capture ${snapshot_name} metrics snapshot" >&2
  fi
}

run_k6_local() {
  k6 run \
    --summary-export "${K6_SUMMARY_FILE}" \
    -e "TARGET=${TARGET}" \
    -e "LOADTEST_BYPASS_KEY=${LOADTEST_BYPASS_KEY}" \
    -e "SEED_FILE=${SEED_FILE}" \
    -e "MODE=${MODE}" \
    -e "BASE_RPS=${BASE_RPS}" \
    -e "SPIKE_MULT=${SPIKE_MULT}" \
    -e "REDIRECT_RATIO=${REDIRECT_RATIO}" \
    -e "PRE_VUS=${PRE_VUS}" \
    -e "MAX_VUS=${MAX_VUS}" \
    -e "HOT_SET_PCT=${HOT_SET_PCT}" \
    -e "HOT_RATIO=${HOT_RATIO}" \
    "${REPO_ROOT}/scripts/loadtest.js" \
    | tee "${K6_LOG_FILE}"
}

run_k6_docker() {
  local container_seed_file
  local container_seed_mount=""

  if [[ "$SEED_FILE" == "${REPO_ROOT}/"* ]]; then
    container_seed_file="/workspace/${SEED_FILE#${REPO_ROOT}/}"
  else
    container_seed_file="/seed/$(basename "$SEED_FILE")"
    container_seed_mount="-v ${SEED_FILE%/*}:/seed:ro"
  fi

  # shellcheck disable=SC2086
  docker run --rm -i \
    -v "${REPO_ROOT}:/workspace" \
    $container_seed_mount \
    -w /workspace \
    grafana/k6 run \
    --summary-export "/workspace/benchmark-results/${RUN_LABEL}/k6-summary.json" \
    -e "TARGET=${TARGET}" \
    -e "LOADTEST_BYPASS_KEY=${LOADTEST_BYPASS_KEY}" \
    -e "SEED_FILE=${container_seed_file}" \
    -e "MODE=${MODE}" \
    -e "BASE_RPS=${BASE_RPS}" \
    -e "SPIKE_MULT=${SPIKE_MULT}" \
    -e "REDIRECT_RATIO=${REDIRECT_RATIO}" \
    -e "PRE_VUS=${PRE_VUS}" \
    -e "MAX_VUS=${MAX_VUS}" \
    -e "HOT_SET_PCT=${HOT_SET_PCT}" \
    -e "HOT_RATIO=${HOT_RATIO}" \
    /workspace/scripts/loadtest.js \
    | tee "${K6_LOG_FILE}"
}

write_metadata
capture_metrics_snapshot "pre-restore"

if [ "$SKIP_RESTORE" != "true" ]; then
  restore_remote_db
fi

wait_for_ready
capture_metrics_snapshot "pre-run"

echo "[benchmark] starting load test"
run_benchmark

capture_metrics_snapshot "post-run"
finalize_metadata

echo "[benchmark] results saved to ${RESULT_DIR}"
