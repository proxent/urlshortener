#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "${SCRIPT_DIR}/.." && pwd)
BENCHMARK_ENV_FILE=${BENCHMARK_ENV_FILE:-${HOME}/.config/urlshortener/benchmark.env}

source "${SCRIPT_DIR}/load-benchmark-env.sh"

usage() {
  printf '%s\n' "Usage:"
  printf '%s\n' "  BENCHMARK_RUNS=5 ./scripts/run-benchmark-series.sh [series-label]"
  printf '\n%s\n' "Runs scripts/run-benchmark.sh multiple times with labels:"
  printf '%s\n' "  <series-label>-r01, <series-label>-r02, ..."
  printf '\n%s\n' "The same environment accepted by run-benchmark.sh is passed through."
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ -f "$BENCHMARK_ENV_FILE" ]; then
  load_benchmark_env_file "$BENCHMARK_ENV_FILE"
  echo "[benchmark-series] loaded environment from ${BENCHMARK_ENV_FILE}"
fi

BENCHMARK_RUNS=${BENCHMARK_RUNS:-5}
RESULTS_BASE_DIR=${RESULTS_BASE_DIR:-${REPO_ROOT}/benchmark-results}
export RESULTS_BASE_DIR

if ! [[ "$BENCHMARK_RUNS" =~ ^[0-9]+$ ]] || [ "$BENCHMARK_RUNS" -lt 1 ]; then
  echo "[benchmark-series] BENCHMARK_RUNS must be a positive integer" >&2
  exit 1
fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
SERIES_LABEL=${1:-${MODE:-realistic}-${BASE_RPS:-500}rps-series-${timestamp}}
SERIES_RESULT_DIR="${RESULTS_BASE_DIR}/${SERIES_LABEL}-series"
RUN_DIRS_FILE="${SERIES_RESULT_DIR}/run-dirs.txt"
EXIT_CODES_FILE="${SERIES_RESULT_DIR}/exit-codes.tsv"
SUMMARY_MARKDOWN_FILE="${SERIES_RESULT_DIR}/series-summary.md"
SUMMARY_JSON_FILE="${SERIES_RESULT_DIR}/series-summary.json"
ARTIFACTS_FILE="${SERIES_RESULT_DIR}/artifacts.txt"

mkdir -p "$SERIES_RESULT_DIR"
: > "$RUN_DIRS_FILE"
: > "$EXIT_CODES_FILE"

run_dirs=()
series_exit_code=0

echo "[benchmark-series] starting ${BENCHMARK_RUNS} runs for ${SERIES_LABEL}"

for run_index in $(seq 1 "$BENCHMARK_RUNS"); do
  run_suffix=$(printf 'r%02d' "$run_index")
  run_label="${SERIES_LABEL}-${run_suffix}"
  run_dir="${RESULTS_BASE_DIR}/${run_label}"

  echo "[benchmark-series] run ${run_index}/${BENCHMARK_RUNS}: ${run_label}"

  set +e
  "${SCRIPT_DIR}/run-benchmark.sh" "$run_label"
  run_exit_code=$?
  set -e

  printf '%s\n' "$run_dir" >> "$RUN_DIRS_FILE"
  printf '%s\t%s\n' "$run_label" "$run_exit_code" >> "$EXIT_CODES_FILE"
  run_dirs+=("$run_dir")

  if [ "$run_exit_code" -ne 0 ]; then
    series_exit_code=1

    if [ ! -f "${run_dir}/k6-summary.json" ]; then
      echo "[benchmark-series] run ${run_label} failed before k6 produced a summary; aborting remaining runs" >&2
      break
    fi

    echo "[benchmark-series] run ${run_label} exited ${run_exit_code}; continuing so the series can be summarized" >&2
  fi
done

echo "[benchmark-series] summarizing run-level results"
node "${SCRIPT_DIR}/summarize-benchmarks.js" \
  --markdown-out "$SUMMARY_MARKDOWN_FILE" \
  --json-out "$SUMMARY_JSON_FILE" \
  "${run_dirs[@]}"

{
  printf '%s\n' "$RUN_DIRS_FILE"
  printf '%s\n' "$EXIT_CODES_FILE"
  printf '%s\n' "$SUMMARY_MARKDOWN_FILE"
  printf '%s\n' "$SUMMARY_JSON_FILE"
} > "$ARTIFACTS_FILE"

echo "[benchmark-series] summary saved to ${SERIES_RESULT_DIR}"

if [ "$series_exit_code" -ne 0 ]; then
  echo "[benchmark-series] one or more runs failed thresholds or setup checks" >&2
fi

exit "$series_exit_code"
