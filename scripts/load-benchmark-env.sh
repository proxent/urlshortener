#!/usr/bin/env bash

load_benchmark_env_file() {
  local env_file=${1:-}

  if [ -z "$env_file" ] || [ ! -f "$env_file" ]; then
    return 0
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    line=${line#"${line%%[![:space:]]*}"}
    line=${line%"${line##*[![:space:]]}"}

    if [ -z "$line" ] || [[ "$line" == \#* ]]; then
      continue
    fi

    if [[ "$line" == export[[:space:]]* ]]; then
      line=${line#export}
      line=${line#"${line%%[![:space:]]*}"}
    fi

    if [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      echo "[benchmark] ignoring unsupported env file line: ${line}" >&2
      continue
    fi

    local key=${line%%=*}

    if [ -n "${!key+x}" ]; then
      continue
    fi

    eval "export ${line}"
  done < "$env_file"
}
