#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "${SCRIPT_DIR}/.." && pwd)
BENCHMARK_ENV_FILE=${BENCHMARK_ENV_FILE:-${HOME}/.config/urlshortener/benchmark.env}

source "${SCRIPT_DIR}/load-benchmark-env.sh"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/run-slo-capacity-benchmark.sh <label>

Finds the highest SLO-compliant RPS by running repeated benchmark series.

Important environment:
  CAPACITY_START_RPS        Adaptive search starting RPS. Default: 200
  CAPACITY_GROWTH_FACTOR   Adaptive growth factor. Default: 1.5
  CAPACITY_MAX_RPS         Adaptive search ceiling. Default: 2000
  CAPACITY_MIN_DELTA_RPS   Stop binary search when high-low is at most this. Default: 50
  CAPACITY_RPS_LEVELS      Optional manual space-separated RPS candidates
  SEARCH_RUNS              Runs per search candidate. Default: 1
  CONFIRM_RUNS             Runs per confirmation candidate. Default: 3
  CAPACITY_SEARCH_DURATION Search LOADTEST_DURATION. Default: 60s
  CAPACITY_CONFIRM_DURATION Confirm LOADTEST_DURATION. Default: 120s
  CAPACITY_DRY_RUN         true to simulate without launching benchmarks
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

LABEL=${1:-}
if [ -z "$LABEL" ]; then
  usage >&2
  exit 1
fi

if [[ ! "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "[capacity] label may only contain letters, numbers, dot, underscore, and dash" >&2
  exit 1
fi

if [ -f "$BENCHMARK_ENV_FILE" ]; then
  load_benchmark_env_file "$BENCHMARK_ENV_FILE"
  echo "[capacity] loaded environment from ${BENCHMARK_ENV_FILE}"
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[capacity] required command not found: $1" >&2
    exit 1
  fi
}

is_positive_integer() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

is_positive_number() {
  [[ "${1:-}" =~ ^[0-9]+([.][0-9]+)?$ ]] && awk -v value="$1" 'BEGIN { exit !(value > 0) }'
}

number_greater_than_one() {
  [[ "${1:-}" =~ ^[0-9]+([.][0-9]+)?$ ]] && awk -v value="$1" 'BEGIN { exit !(value > 1) }'
}

number_between_zero_and_one() {
  [[ "${1:-}" =~ ^[0-9]+([.][0-9]+)?$ ]] && awk -v value="$1" 'BEGIN { exit !(value >= 0 && value <= 1) }'
}

require_positive_integer() {
  local name=$1
  local value=$2

  if ! is_positive_integer "$value"; then
    echo "[capacity] ${name} must be a positive integer" >&2
    exit 1
  fi
}

require_command awk
require_command sort

MODE=${MODE:-realistic}
SPIKE_MULT=${SPIKE_MULT:-1}
REDIRECT_RATIO=${REDIRECT_RATIO:-0.98}

CAPACITY_START_RPS=${CAPACITY_START_RPS:-200}
CAPACITY_GROWTH_FACTOR=${CAPACITY_GROWTH_FACTOR:-1.5}
CAPACITY_MAX_RPS=${CAPACITY_MAX_RPS:-2000}
CAPACITY_MIN_DELTA_RPS=${CAPACITY_MIN_DELTA_RPS:-50}
CAPACITY_RPS_LEVELS=${CAPACITY_RPS_LEVELS:-}
SEARCH_RUNS=${SEARCH_RUNS:-1}
CONFIRM_RUNS=${CONFIRM_RUNS:-3}
CAPACITY_SEARCH_DURATION=${CAPACITY_SEARCH_DURATION:-60s}
CAPACITY_CONFIRM_DURATION=${CAPACITY_CONFIRM_DURATION:-120s}
CAPACITY_DRY_RUN=${CAPACITY_DRY_RUN:-false}
CAPACITY_DRY_RUN_PASS_UNTIL_RPS=${CAPACITY_DRY_RUN_PASS_UNTIL_RPS:-}
CAPACITY_DRY_RUN_CONFIRM_FAIL_RPS=${CAPACITY_DRY_RUN_CONFIRM_FAIL_RPS:-}

RESULTS_BASE_DIR=${RESULTS_BASE_DIR:-${REPO_ROOT}/benchmark-results}
if [[ "$RESULTS_BASE_DIR" != /* ]]; then
  RESULTS_BASE_DIR="${REPO_ROOT}/${RESULTS_BASE_DIR}"
fi

CAPACITY_RESULT_DIR="${RESULTS_BASE_DIR}/${LABEL}-capacity"
RUNS_BASE_DIR="${CAPACITY_RESULT_DIR}/runs"
ATTEMPTS_TSV="${CAPACITY_RESULT_DIR}/capacity-attempts.tsv"
SUMMARY_MARKDOWN_FILE="${CAPACITY_RESULT_DIR}/capacity-summary.md"
SUMMARY_JSON_FILE="${CAPACITY_RESULT_DIR}/capacity-summary.json"

SEARCH_MODE=adaptive
if [ -n "$CAPACITY_RPS_LEVELS" ]; then
  SEARCH_MODE=manual
fi

require_positive_integer CAPACITY_START_RPS "$CAPACITY_START_RPS"
require_positive_integer CAPACITY_MAX_RPS "$CAPACITY_MAX_RPS"
require_positive_integer CAPACITY_MIN_DELTA_RPS "$CAPACITY_MIN_DELTA_RPS"
require_positive_integer SEARCH_RUNS "$SEARCH_RUNS"
require_positive_integer CONFIRM_RUNS "$CONFIRM_RUNS"

if ! number_greater_than_one "$CAPACITY_GROWTH_FACTOR"; then
  echo "[capacity] CAPACITY_GROWTH_FACTOR must be greater than 1" >&2
  exit 1
fi

if [ "$CAPACITY_MAX_RPS" -lt "$CAPACITY_START_RPS" ]; then
  echo "[capacity] CAPACITY_MAX_RPS must be greater than or equal to CAPACITY_START_RPS" >&2
  exit 1
fi

if ! is_positive_number "$SPIKE_MULT"; then
  echo "[capacity] SPIKE_MULT must be a positive number" >&2
  exit 1
fi

if ! number_between_zero_and_one "$REDIRECT_RATIO"; then
  echo "[capacity] REDIRECT_RATIO must be between 0 and 1" >&2
  exit 1
fi

if [ "$CAPACITY_DRY_RUN" = "true" ]; then
  if [ -z "$CAPACITY_DRY_RUN_PASS_UNTIL_RPS" ]; then
    CAPACITY_DRY_RUN_PASS_UNTIL_RPS=$CAPACITY_MAX_RPS
  fi

  require_positive_integer CAPACITY_DRY_RUN_PASS_UNTIL_RPS "$CAPACITY_DRY_RUN_PASS_UNTIL_RPS"

  if [ -n "$CAPACITY_DRY_RUN_CONFIRM_FAIL_RPS" ]; then
    for fail_rps in $CAPACITY_DRY_RUN_CONFIRM_FAIL_RPS; do
      require_positive_integer CAPACITY_DRY_RUN_CONFIRM_FAIL_RPS "$fail_rps"
    done
  fi
fi

mkdir -p "$CAPACITY_RESULT_DIR" "$RUNS_BASE_DIR"
: > "$ATTEMPTS_TSV"

declare -A SEARCH_STATUS_BY_RPS=()
declare -A SEARCH_EXIT_BY_RPS=()
PASS_RPS_LIST=()

LAST_CANDIDATE_STATUS=
LAST_CANDIDATE_EXIT_CODE=
HIGHEST_SEARCH_PASS=
CONFIRMED_CAPACITY_RPS=
CONFIRMATION_STATUS=not_started
SEARCH_CAPPED=false
RESULT_CAPPED=false
NO_CAPACITY_REASON=

ceil_growth_rps() {
  local current=$1
  local next

  next=$(awk -v current="$current" -v factor="$CAPACITY_GROWTH_FACTOR" 'BEGIN { printf "%d", int(current * factor + 0.999999) }')

  if [ "$next" -le "$current" ]; then
    next=$((current + 1))
  fi

  if [ "$next" -gt "$CAPACITY_MAX_RPS" ]; then
    next=$CAPACITY_MAX_RPS
  fi

  printf '%s\n' "$next"
}

effective_peak_rps() {
  local base_rps=$1
  local peak

  if [ "$MODE" = "cold" ] || [ "$MODE" = "warm" ]; then
    printf '%s\n' "$base_rps"
    return 0
  fi

  peak=$(awk -v base="$base_rps" -v spike="$SPIKE_MULT" 'BEGIN { printf "%d", int(base * spike) }')
  if [ "$peak" -lt "$base_rps" ]; then
    peak=$base_rps
  fi

  printf '%s\n' "$peak"
}

redirect_target_rps() {
  local peak_rps=$1
  awk -v peak="$peak_rps" -v ratio="$REDIRECT_RATIO" 'BEGIN { printf "%d", int(peak * ratio) }'
}

shorten_target_rps() {
  local peak_rps=$1
  awk -v peak="$peak_rps" -v ratio="$REDIRECT_RATIO" 'BEGIN { value = int(peak * (1 - ratio)); if (value < 1) value = 1; printf "%d", value }'
}

value_in_list() {
  local needle=$1
  local values=${2:-}
  local value

  for value in $values; do
    if [ "$value" = "$needle" ]; then
      return 0
    fi
  done

  return 1
}

dry_run_candidate_passes() {
  local phase=$1
  local rps=$2

  if [ "$phase" = "confirm" ] && value_in_list "$rps" "$CAPACITY_DRY_RUN_CONFIRM_FAIL_RPS"; then
    return 1
  fi

  [ "$rps" -le "$CAPACITY_DRY_RUN_PASS_UNTIL_RPS" ]
}

record_attempt() {
  local phase=$1
  local rps=$2
  local status=$3
  local exit_code=$4
  local run_count=$5
  local duration=$6
  local series_label=$7
  local series_dir=$8
  local peak_rps=$9
  local redirect_rps=${10}
  local shorten_rps=${11}

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$phase" \
    "$rps" \
    "$status" \
    "$exit_code" \
    "$run_count" \
    "$duration" \
    "$series_label" \
    "$series_dir" \
    "$peak_rps" \
    "$redirect_rps" \
    "$shorten_rps" >> "$ATTEMPTS_TSV"
}

run_candidate() {
  local phase=$1
  local rps=$2
  local run_count=$3
  local duration=$4
  local series_label="${LABEL}-${phase}-${rps}rps"
  local series_dir="${RUNS_BASE_DIR}/${series_label}-series"
  local exit_code
  local status
  local peak_rps
  local redirect_rps
  local shorten_rps

  peak_rps=$(effective_peak_rps "$rps")
  redirect_rps=$(redirect_target_rps "$peak_rps")
  shorten_rps=$(shorten_target_rps "$peak_rps")

  echo "[capacity] ${phase}: ${rps} RPS, ${run_count} run(s), duration ${duration}"

  if [ "$CAPACITY_DRY_RUN" = "true" ]; then
    mkdir -p "$series_dir"

    if dry_run_candidate_passes "$phase" "$rps"; then
      exit_code=0
    else
      exit_code=1
    fi

    {
      printf 'CAPACITY_DRY_RUN=true\n'
      printf 'PHASE=%s\n' "$phase"
      printf 'BASE_RPS=%s\n' "$rps"
      printf 'BENCHMARK_RUNS=%s\n' "$run_count"
      printf 'LOADTEST_DURATION=%s\n' "$duration"
      printf 'SIMULATED_EXIT_CODE=%s\n' "$exit_code"
    } > "${series_dir}/dry-run.env"
  else
    set +e
    MODE="$MODE" \
      SPIKE_MULT="$SPIKE_MULT" \
      REDIRECT_RATIO="$REDIRECT_RATIO" \
      BASE_RPS="$rps" \
      BENCHMARK_RUNS="$run_count" \
      LOADTEST_DURATION="$duration" \
      RESULTS_BASE_DIR="$RUNS_BASE_DIR" \
      "${SCRIPT_DIR}/run-benchmark-series.sh" "$series_label"
    exit_code=$?
    set -e
  fi

  if [ "$exit_code" -eq 0 ]; then
    status=pass
  else
    status=fail
  fi

  record_attempt "$phase" "$rps" "$status" "$exit_code" "$run_count" "$duration" "$series_label" "$series_dir" "$peak_rps" "$redirect_rps" "$shorten_rps"

  LAST_CANDIDATE_STATUS=$status
  LAST_CANDIDATE_EXIT_CODE=$exit_code
}

run_search_candidate() {
  local rps=$1

  if [ -n "${SEARCH_STATUS_BY_RPS[$rps]+x}" ]; then
    LAST_CANDIDATE_STATUS=${SEARCH_STATUS_BY_RPS[$rps]}
    LAST_CANDIDATE_EXIT_CODE=${SEARCH_EXIT_BY_RPS[$rps]}
    return 0
  fi

  run_candidate search "$rps" "$SEARCH_RUNS" "$CAPACITY_SEARCH_DURATION"
  SEARCH_STATUS_BY_RPS[$rps]=$LAST_CANDIDATE_STATUS
  SEARCH_EXIT_BY_RPS[$rps]=$LAST_CANDIDATE_EXIT_CODE

  if [ "$LAST_CANDIDATE_STATUS" = "pass" ]; then
    PASS_RPS_LIST+=("$rps")
  fi
}

highest_pass_rps() {
  if [ "${#PASS_RPS_LIST[@]}" -eq 0 ]; then
    return 0
  fi

  printf '%s\n' "${PASS_RPS_LIST[@]}" | sort -nr | awk 'NR == 1 { print; exit }'
}

pass_candidates_desc() {
  if [ "${#PASS_RPS_LIST[@]}" -eq 0 ]; then
    return 0
  fi

  printf '%s\n' "${PASS_RPS_LIST[@]}" | sort -nr | awk '!seen[$0]++'
}

parse_manual_candidates() {
  local token
  local levels=()

  for token in $CAPACITY_RPS_LEVELS; do
    require_positive_integer CAPACITY_RPS_LEVELS "$token"
    levels+=("$token")
  done

  if [ "${#levels[@]}" -eq 0 ]; then
    echo "[capacity] CAPACITY_RPS_LEVELS must contain at least one positive integer" >&2
    exit 1
  fi

  mapfile -t MANUAL_CANDIDATES < <(printf '%s\n' "${levels[@]}" | sort -n -u)
}

run_manual_search() {
  local rps

  parse_manual_candidates

  for rps in "${MANUAL_CANDIDATES[@]}"; do
    run_search_candidate "$rps"
  done

  if [ "${#PASS_RPS_LIST[@]}" -eq 0 ]; then
    NO_CAPACITY_REASON="all manual candidates failed"
    CONFIRMATION_STATUS=skipped_no_search_pass
  fi
}

run_adaptive_search() {
  local low
  local high=
  local current
  local next
  local mid

  run_search_candidate "$CAPACITY_START_RPS"

  if [ "$LAST_CANDIDATE_STATUS" != "pass" ]; then
    NO_CAPACITY_REASON="CAPACITY_START_RPS failed"
    CONFIRMATION_STATUS=skipped_start_failed
    return 0
  fi

  low=$CAPACITY_START_RPS
  current=$CAPACITY_START_RPS

  if [ "$current" -eq "$CAPACITY_MAX_RPS" ]; then
    SEARCH_CAPPED=true
    return 0
  fi

  while [ "$current" -lt "$CAPACITY_MAX_RPS" ]; do
    next=$(ceil_growth_rps "$current")
    run_search_candidate "$next"

    if [ "$LAST_CANDIDATE_STATUS" = "pass" ]; then
      low=$next
      current=$next

      if [ "$current" -eq "$CAPACITY_MAX_RPS" ]; then
        SEARCH_CAPPED=true
        return 0
      fi
    else
      high=$next
      break
    fi
  done

  if [ -z "$high" ]; then
    SEARCH_CAPPED=true
    return 0
  fi

  while [ $((high - low)) -gt "$CAPACITY_MIN_DELTA_RPS" ]; do
    mid=$((low + (high - low) / 2))

    if [ "$mid" -le "$low" ] || [ "$mid" -ge "$high" ]; then
      break
    fi

    run_search_candidate "$mid"

    if [ "$LAST_CANDIDATE_STATUS" = "pass" ]; then
      low=$mid
    else
      high=$mid
    fi
  done
}

run_confirmation() {
  local candidate
  local candidates=()

  HIGHEST_SEARCH_PASS=$(highest_pass_rps)

  if [ -z "$HIGHEST_SEARCH_PASS" ]; then
    if [ -z "$CONFIRMATION_STATUS" ] || [ "$CONFIRMATION_STATUS" = "not_started" ]; then
      CONFIRMATION_STATUS=skipped_no_search_pass
    fi
    return 0
  fi

  CONFIRMATION_STATUS=failed

  mapfile -t candidates < <(pass_candidates_desc)

  for candidate in "${candidates[@]}"; do
    [ -n "$candidate" ] || continue

    run_candidate confirm "$candidate" "$CONFIRM_RUNS" "$CAPACITY_CONFIRM_DURATION"

    if [ "$LAST_CANDIDATE_STATUS" = "pass" ]; then
      CONFIRMED_CAPACITY_RPS=$candidate
      CONFIRMATION_STATUS=confirmed
      return 0
    fi
  done
}

json_string() {
  local value=${1:-}
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '"%s"' "$value"
}

json_nullable_string() {
  if [ -z "${1:-}" ]; then
    printf 'null'
  else
    json_string "$1"
  fi
}

json_nullable_number() {
  if [ -z "${1:-}" ]; then
    printf 'null'
  else
    printf '%s' "$1"
  fi
}

json_bool() {
  if [ "${1:-}" = "true" ]; then
    printf 'true'
  else
    printf 'false'
  fi
}

write_summary_json() {
  local confirmed_peak=
  local confirmed_redirect=
  local confirmed_shorten=
  local first

  if [ -n "$CONFIRMED_CAPACITY_RPS" ]; then
    confirmed_peak=$(effective_peak_rps "$CONFIRMED_CAPACITY_RPS")
    confirmed_redirect=$(redirect_target_rps "$confirmed_peak")
    confirmed_shorten=$(shorten_target_rps "$confirmed_peak")
  fi

  {
    printf '{\n'
    printf '  "label": %s,\n' "$(json_string "$LABEL")"
    printf '  "searchMode": %s,\n' "$(json_string "$SEARCH_MODE")"
    printf '  "mode": %s,\n' "$(json_string "$MODE")"
    printf '  "spikeMult": %s,\n' "$SPIKE_MULT"
    printf '  "redirectRatio": %s,\n' "$REDIRECT_RATIO"
    printf '  "searchRuns": %s,\n' "$SEARCH_RUNS"
    printf '  "confirmRuns": %s,\n' "$CONFIRM_RUNS"
    printf '  "searchDuration": %s,\n' "$(json_string "$CAPACITY_SEARCH_DURATION")"
    printf '  "confirmDuration": %s,\n' "$(json_string "$CAPACITY_CONFIRM_DURATION")"
    printf '  "capacityStartRps": %s,\n' "$CAPACITY_START_RPS"
    printf '  "capacityGrowthFactor": %s,\n' "$CAPACITY_GROWTH_FACTOR"
    printf '  "capacityMaxRps": %s,\n' "$CAPACITY_MAX_RPS"
    printf '  "capacityMinDeltaRps": %s,\n' "$CAPACITY_MIN_DELTA_RPS"
    printf '  "candidateRpsTested": ['
    first=true
    while IFS= read -r candidate_rps; do
      [ -n "$candidate_rps" ] || continue
      if [ "$first" = "true" ]; then
        first=false
      else
        printf ', '
      fi
      printf '%s' "$candidate_rps"
    done < <(awk -F '\t' '$1 == "search" { print $2 }' "$ATTEMPTS_TSV" | sort -n -u)
    printf '],\n'
    printf '  "highestSearchPass": %s,\n' "$(json_nullable_number "$HIGHEST_SEARCH_PASS")"
    printf '  "confirmedCapacityRps": %s,\n' "$(json_nullable_number "$CONFIRMED_CAPACITY_RPS")"
    printf '  "confirmedEffectivePeakRps": %s,\n' "$(json_nullable_number "$confirmed_peak")"
    printf '  "confirmedRedirectTargetRps": %s,\n' "$(json_nullable_number "$confirmed_redirect")"
    printf '  "confirmedShortenTargetRps": %s,\n' "$(json_nullable_number "$confirmed_shorten")"
    printf '  "confirmationStatus": %s,\n' "$(json_string "$CONFIRMATION_STATUS")"
    printf '  "resultCappedByMaxRps": %s,\n' "$(json_bool "$RESULT_CAPPED")"
    printf '  "searchCappedByMaxRps": %s,\n' "$(json_bool "$SEARCH_CAPPED")"
    printf '  "noCapacityReason": %s,\n' "$(json_nullable_string "$NO_CAPACITY_REASON")"
    printf '  "resultDir": %s,\n' "$(json_string "$CAPACITY_RESULT_DIR")"
    printf '  "runsBaseDir": %s,\n' "$(json_string "$RUNS_BASE_DIR")"
    printf '  "attempts": [\n'

    first=true
    while IFS=$'\t' read -r phase rps status exit_code run_count duration series_label series_dir peak_rps redirect_rps shorten_rps; do
      [ -n "$phase" ] || continue
      if [ "$first" = "true" ]; then
        first=false
      else
        printf ',\n'
      fi

      printf '    {'
      printf '"phase": %s, ' "$(json_string "$phase")"
      printf '"baseRps": %s, ' "$rps"
      printf '"status": %s, ' "$(json_string "$status")"
      printf '"exitCode": %s, ' "$exit_code"
      printf '"runCount": %s, ' "$run_count"
      printf '"duration": %s, ' "$(json_string "$duration")"
      printf '"seriesLabel": %s, ' "$(json_string "$series_label")"
      printf '"resultDir": %s, ' "$(json_string "$series_dir")"
      printf '"effectivePeakRps": %s, ' "$peak_rps"
      printf '"redirectTargetRps": %s, ' "$redirect_rps"
      printf '"shortenTargetRps": %s' "$shorten_rps"
      printf '}'
    done < "$ATTEMPTS_TSV"

    printf '\n  ]\n'
    printf '}\n'
  } > "$SUMMARY_JSON_FILE"
}

write_summary_markdown() {
  {
    printf '# SLO Capacity Benchmark: %s\n\n' "$LABEL"

    printf '## Result\n\n'
    if [ -n "$CONFIRMED_CAPACITY_RPS" ]; then
      local confirmed_peak
      local confirmed_redirect
      local confirmed_shorten
      confirmed_peak=$(effective_peak_rps "$CONFIRMED_CAPACITY_RPS")
      confirmed_redirect=$(redirect_target_rps "$confirmed_peak")
      confirmed_shorten=$(shorten_target_rps "$confirmed_peak")

      printf -- '- Confirmed SLO capacity: **%s BASE_RPS**\n' "$CONFIRMED_CAPACITY_RPS"
      printf -- '- Effective peak RPS: `%s`\n' "$confirmed_peak"
      printf -- '- Effective redirect/shorten target RPS: `%s` / `%s`\n' "$confirmed_redirect" "$confirmed_shorten"
    else
      printf -- '- Confirmed SLO capacity: **none**\n'
      if [ -n "$NO_CAPACITY_REASON" ]; then
        printf -- '- Reason: `%s`\n' "$NO_CAPACITY_REASON"
      fi
    fi

    printf -- '- Search mode: `%s`\n' "$SEARCH_MODE"
    printf -- '- Confirmation status: `%s`\n' "$CONFIRMATION_STATUS"
    printf -- '- Result capped by CAPACITY_MAX_RPS: `%s`\n' "$RESULT_CAPPED"
    printf -- '- MODE / SPIKE_MULT / REDIRECT_RATIO: `%s` / `%s` / `%s`\n\n' "$MODE" "$SPIKE_MULT" "$REDIRECT_RATIO"

    printf '## LinkedIn Summary\n\n'
    if [ -n "$CONFIRMED_CAPACITY_RPS" ]; then
      printf 'SLO-compliant capacity was confirmed at **%s BASE_RPS** on the same benchmark environment, using `%s` traffic with `SPIKE_MULT=%s`.\n\n' "$CONFIRMED_CAPACITY_RPS" "$MODE" "$SPIKE_MULT"
    else
      printf 'No SLO-compliant capacity was confirmed for this configuration.\n\n'
    fi

    printf '## Attempts\n\n'
    printf '| Phase | BASE_RPS | Peak RPS | Redirect RPS | Shorten RPS | Status | Runs | Duration | Result Dir |\n'
    printf '| --- | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |\n'

    while IFS=$'\t' read -r phase rps status exit_code run_count duration series_label series_dir peak_rps redirect_rps shorten_rps; do
      [ -n "$phase" ] || continue
      printf '| `%s` | %s | %s | %s | %s | `%s` | %s | `%s` | `%s` |\n' \
        "$phase" \
        "$rps" \
        "$peak_rps" \
        "$redirect_rps" \
        "$shorten_rps" \
        "$status" \
        "$run_count" \
        "$duration" \
        "$series_dir"
    done < "$ATTEMPTS_TSV"
  } > "$SUMMARY_MARKDOWN_FILE"
}

write_summary() {
  write_summary_json
  write_summary_markdown
}

if [ "$SEARCH_MODE" = "manual" ]; then
  run_manual_search
else
  run_adaptive_search
fi

run_confirmation

if [ -z "$CONFIRMED_CAPACITY_RPS" ] && [ "$CONFIRMATION_STATUS" = "failed" ]; then
  NO_CAPACITY_REASON="all confirmation candidates failed"
fi

if [ "$SEARCH_CAPPED" = "true" ] && [ "${CONFIRMED_CAPACITY_RPS:-}" = "$CAPACITY_MAX_RPS" ]; then
  RESULT_CAPPED=true
fi

write_summary

echo "[capacity] summary saved to ${CAPACITY_RESULT_DIR}"

if [ -n "$CONFIRMED_CAPACITY_RPS" ]; then
  echo "[capacity] confirmed SLO capacity: ${CONFIRMED_CAPACITY_RPS} BASE_RPS"
else
  echo "[capacity] no confirmed SLO capacity"
fi
