#!/usr/bin/env python3
"""Run the two-replica capacity study on an isolated Linux host."""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import secrets
import signal
import statistics
import subprocess
import time

HERE = Path(__file__).resolve().parent
APP_MODULE = "a4af9c110f925f8c05094563d391b47e1181ce7eb99a33cff83dab30e82fbb49"
SEED_ROWS = 20_000
CPU_LIMIT = "0.7"
CLOSEST_RPS = (600, 800, 1000, 1250, 1500, 1800, 2100, 2400, 2800, 3200)
GRID = 50


def call(args, *, env=None, data=None, check=True, timeout=40):
    process = subprocess.run(args, input=data, env=env, text=True, capture_output=True, timeout=timeout)
    if check and process.returncode:
        raise RuntimeError(f"{args[0]} {args[1]} exited {process.returncode}: {process.stderr[-800:]}")
    return process.stdout.strip()


def file_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf8")


def container_cpu(name):
    pid = call(["docker", "inspect", "--format", "{{.State.Pid}}", name])
    relative = Path(f"/proc/{pid}/cgroup").read_text().split("::", 1)[1].strip().lstrip("/")
    with Path("/sys/fs/cgroup", relative, "cpu.stat").open() as metrics:
        return {line.split()[0]: int(line.split()[1]) for line in metrics}


def proc_cpu(pid):
    try:
        stats = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return (int(stats[11]) + int(stats[12])) / os.sysconf("SC_CLK_TCK")
    except FileNotFoundError:
        return None


def system_cpu(names):
    return {
        row[0]: [int(value) for value in row[1:9]]
        for line in Path("/proc/stat").read_text().splitlines()
        if (row := line.split()) and row[0] in names
    }


def cpu_policy(spec):
    available = os.sched_getaffinity(0)
    if spec:
        cores = [int(cpu) for cpu in spec.split(",")]
    else:
        cores = []
        physical = set()
        for cpu in sorted(available):
            topology = Path(f"/sys/devices/system/cpu/cpu{cpu}/topology")
            key = (topology / "physical_package_id").read_text(), (topology / "core_id").read_text()
            if key not in physical:
                physical.add(key)
                cores.append(cpu)
            if len(cores) == 5:
                break
    if len(cores) < 4 or len(set(cores)) != len(cores) or not set(cores) <= available:
        raise ValueError("Supply at least four distinct available cores for app A, app B, DB, and k6")
    return cores


class Lab:
    def __init__(self, args):
        self.args = args
        self.out = args.out.resolve()
        self.out.mkdir(parents=True, exist_ok=False)
        self.cores = cpu_policy(args.cpus)
        self.seed_file = self.out / "seeds.json"
        file_json(self.seed_file, [f"{number:08d}" for number in range(1, SEED_ROWS + 1)])
        self.prefix = f"url-cap-{secrets.token_hex(5)}"
        self.db = self.prefix + "-db"
        self.apps = [self.prefix + "-a", self.prefix + "-b"]
        self.net = self.prefix + "-network"
        self.secret = secrets.token_hex(24)
        self.design = random.Random(20261120)
        self.trials = []
        self.started = time.monotonic()

    def psql(self, database, sql, csv=False):
        flag = ["--csv"] if csv else ["-At"]
        return call(["docker", "exec", "-i", self.db, "psql", "-Xq", *flag,
                     "-v", "ON_ERROR_STOP=1", "-U", "bench", "-d", database], data=sql)

    def start(self):
        network_options = ["--internal", "--subnet", "172.30.252.0/28"] if self.args.bridge else []
        call(["docker", "network", "create", *network_options, self.net])
        env = dict(os.environ, POSTGRES_PASSWORD=self.secret)
        call(["docker", "run", "-d", "--pull=never", "--name", self.db, "--network", self.net,
              "--network-alias", "db", "--cpuset-cpus", str(self.cores[2]), "--cpus", "0.95",
              "--memory", "1536m", "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_USER=bench",
              "-e", "POSTGRES_DB=bench", self.args.db_image, "-c", "shared_preload_libraries=pg_stat_statements",
              "-c", "track_io_timing=on"], env=env)
        for _ in range(35):
            if subprocess.run(["docker", "exec", self.db, "pg_isready", "-q", "-h", "127.0.0.1",
                               "-U", "bench", "-d", "bench"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(.5)
        self.psql("bench", "CREATE DATABASE study_template")
        self.psql("study_template", (HERE / "migration.sql").read_text() + """
CREATE EXTENSION pg_stat_statements;
INSERT INTO "Url" ("code", "originalUrl")
SELECT lpad(n::text, 8, '0'), 'https://bench.invalid/seed/' || lpad(n::text, 8, '0')
FROM generate_series(1, 20000) AS n;
ANALYZE "Url";
""")
        self.fingerprint = self.psql("study_template", """
SELECT count(*), sum("hitCount"), md5(string_agg(code || "originalUrl", '|' ORDER BY code))
FROM "Url";""")
        assert re.fullmatch(r"20000\|0\|[a-f0-9]{32}", self.fingerprint)
        module = call(["docker", "run", "--rm", "--pull=never", "--network", "none", "--entrypoint",
                       "sha256sum", self.args.image, "/app/dist/shortenerStore.js"]).split()[0]
        if module != APP_MODULE:
            raise RuntimeError("App module does not match the deployed revision")
        metadata = {
            "started_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "source": self.args.source,
            "platform": call(["uname", "-sm"]),
            "cpu": call(["lscpu", "-J"]),
            "cores": self.cores,
            "app_cpu_limit": CPU_LIMIT,
            "db_cpu_limit": 0.95,
            "app_image": call(["docker", "image", "inspect", "--format", "{{.Id}} {{.Architecture}} {{json .RepoDigests}}", self.args.image]),
            "db_image": call(["docker", "image", "inspect", "--format", "{{.Id}} {{.Architecture}} {{json .RepoDigests}}", self.args.db_image]),
            "app_module_sha256": module,
            "db_version": self.psql("bench", "SELECT version()"),
            "db_fingerprint": self.fingerprint,
            "client": call([self.args.k6, "version"]),
            "http_path": "internal Docker bridge" if self.args.bridge else "loopback port publishing",
            "latency_clock": "scheduled request" if self.args.scheduled_latency else "actual start",
            "input_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                             for p in (HERE / "capacity-load.js", HERE / "migration.sql", Path(__file__), self.seed_file)},
        }
        file_json(self.out / "environment.json", metadata)
        print("ENVIRONMENT " + json.dumps({k: metadata[k] for k in ("source", "platform", "cores", "app_image", "db_version", "client")}), flush=True)

    def start_apps(self, database):
        origins = []
        for slot, name in enumerate(self.apps):
            env = dict(os.environ, DATABASE_URL=f"postgresql://bench:{self.secret}@db:5432/{database}")
            publish = [] if self.args.bridge else ["-p", "127.0.0.1::3000"]
            call(["docker", "run", "-d", "--pull=never", "--name", name, "--network", self.net,
                  "--cpuset-cpus", str(self.cores[slot]), "--cpus", CPU_LIMIT, "--memory", "1024m",
                  *publish, "-e", "DATABASE_URL", "-e", "BASE_URL=http://bench.invalid",
                  "-e", "NODE_ENV=production", "-e", "TRUST_PROXY=false", "-e", "RATE_LIMIT_MAX_SHORTEN=1000000",
                  self.args.image], env=env)
            if self.args.bridge:
                details = json.loads(call(["docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", name]))
                address = details[self.net]["IPAddress"]
                if not re.fullmatch(r"172\.30\.252\.(?:[2-9]|1[0-4])", address):
                    raise RuntimeError("The app is outside the internal lab bridge")
                socket = address + ":3000"
            else:
                socket = call(["docker", "port", name, "3000/tcp"])
                if not re.fullmatch(r"127\.0\.0\.1:\d+", socket):
                    raise RuntimeError("The app port is not bound to loopback")
            origin = "http://" + socket
            for _ in range(50):
                ready = call(["curl", "--noproxy", "*", "--max-time", "1", "-fsS", origin + "/readyz"], check=False)
                if ready == '{"status":"ready"}':
                    break
                time.sleep(.2)
            else:
                raise RuntimeError("Trial replica did not become ready")
            origins.append(origin)
        return origins

    def hits(self, database):
        return int(self.psql(database, 'SELECT coalesce(sum("hitCount"), 0) FROM "Url"'))

    def drained_warmup(self, database):
        started = time.monotonic()
        values = [{"seconds": 0, "hits": self.hits(database)}]
        while time.monotonic() - started < 40:
            time.sleep(3)
            values.append({"seconds": round(time.monotonic() - started, 3), "hits": self.hits(database)})
            if len(values) >= 4 and len({row["hits"] for row in values[-4:]}) == 1:
                return values, True
        return values, False

    def phase(self, out, phase, seconds, seed, redirects, creates, origins, database=None):
        generator = self.cores[3:]
        names = [f"cpu{cpu}" for cpu in generator]
        env = dict(os.environ, TARGET=",".join(origins), SEED_FILE=str(self.seed_file),
                   BENCHMARK_PHASE=phase, BENCHMARK_SECONDS=str(seconds), BENCHMARK_SEED=str(seed),
                   REDIRECT_RPS=str(redirects), SHORTEN_RPS=str(creates),
                   REDIRECT_VUS=str(self.args.redirect_inflight), SHORTEN_VUS=str(self.args.shorten_inflight),
                   HOT_RATIO="0", HOT_SET_PCT="0.01", LOADTEST_BYPASS_KEY="", GOMAXPROCS=str(len(generator)),
                   CAPACITY_LATENCY_CLOCK="scheduled" if self.args.scheduled_latency else "actual",
                   NO_PROXY="127.0.0.1", HTTP_PROXY="", HTTPS_PROXY="", ALL_PROXY="", K6_NO_USAGE_REPORT="true")
        cpu_samples = []
        hit_samples = []
        next_snapshot = 10
        with (out / f"{phase}.log").open("w") as log:
            command = ["taskset", "-c", ",".join(map(str, generator)), self.args.k6, "run", "--quiet",
                       "--summary-export", str(out / f"{phase}.json"), str(HERE / "capacity-load.js")]
            child = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT)
            begin = time.monotonic()
            last = begin
            previous_cpu = 0
            previous_cores = system_cpu(names)
            try:
                while child.poll() is None:
                    time.sleep(.5)
                    now = time.monotonic()
                    cpu = proc_cpu(child.pid)
                    ticks = system_cpu(names)
                    if cpu is not None:
                        elapsed = now - last
                        usage = (cpu - previous_cpu) / elapsed
                        totals = [sum(ticks[name]) - sum(previous_cores[name]) for name in ticks]
                        idle = sum(ticks[name][3] - previous_cores[name][3] for name in ticks)
                        steal = sum(ticks[name][7] - previous_cores[name][7] for name in ticks)
                        cpu_samples.append(dict(t=now-begin, cpu_cores=round(usage, 4),
                                                idle=(idle/sum(totals) if sum(totals) else 0),
                                                steal=(steal/sum(totals) if sum(totals) else 0)))
                        last, previous_cpu, previous_cores = now, cpu, ticks
                    if database and now - begin >= next_snapshot and next_snapshot <= seconds:
                        hit_samples.append(dict(seconds=round(now-begin, 3), hits=self.hits(database)))
                        next_snapshot += 10
                    if now - begin > seconds + 42:
                        raise TimeoutError("k6 exceeded the phase's time limit")
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()
        file_json(out / f"{phase}-cpu.json", cpu_samples)
        if database:
            file_json(out / f"{phase}-hits.json", hit_samples)
        if child.returncode not in (0, 99):
            raise RuntimeError(f"k6 exited {child.returncode}; see {out}/{phase}.log")
        metrics = json.loads((out / f"{phase}.json").read_text())["metrics"]
        # VU creation and shutdown are outside the main arrival window. Keep the samples for auditing.
        window = [row["cpu_cores"] / len(generator) for row in cpu_samples if 3 <= row["t"] <= seconds]
        p95 = statistics.quantiles(window, n=20, method="inclusive")[18] if len(window) > 2 else 1
        result = {"exit": child.returncode, "client_cpu_p95": round(p95, 3),
                  "dropped": metrics["dropped_iterations"]["count"],
                  "max_vus": metrics.get("vus", {}).get("max", 0)}
        if "generator_lag_ms" in metrics:
            result["client_schedule_lag_p99_ms"] = metrics["generator_lag_ms"]["p(99)"]
            result["client_schedule_lag_p999_ms"] = metrics["generator_lag_ms"].get("p(99.9)", 0)
            result["client_late"] = metrics["generator_lag_ms"]["unscheduled"]
        for name, planned in (("redirect", redirects * seconds), ("shorten", creates * seconds)):
            prefix = f"benchmark_{name}"
            latency = metrics[prefix + "_latency_ms"]
            success = metrics[prefix + "_success"]
            result[name] = {"offered": planned, "completed": metrics[prefix + "_completed"]["count"],
                            "success": success["passes"], "failures": success["fails"],
                            "p95_ms": latency["p(95)"], "p99_ms": latency["p(99)"]}
        return result

    def trial(self, rate, stage, seed=None):
        index = len(self.trials) + 1
        database = f"bench_r{index}"
        out = self.out / f"{index:02}-{stage}-{rate}"
        out.mkdir()
        seconds = self.args.measure if stage == "confirm" else self.args.explore_measure
        warmup = self.args.warmup if stage == "confirm" else self.args.explore_warmup
        seed = self.design.randrange(2**32) if seed is None else seed
        creates = round(rate * .02)
        redirects = rate - creates
        warm_rate = min(rate, self.args.warmup_rate or rate)
        warm_creates = round(warm_rate * .02)
        phase_begin = time.monotonic()
        print(f"START {index:02} {stage} {rate} RPS", flush=True)
        try:
            self.psql("bench", f"CREATE DATABASE {database} TEMPLATE study_template")
            origins = self.start_apps(database)
            pre = self.phase(out, "warmup", warmup, seed, warm_rate - warm_creates, warm_creates, origins)
            warm_hits, baseline_stable = self.drained_warmup(database)
            file_json(out / "warmup-hits.json", warm_hits)
            baseline = warm_hits[-1]["hits"]
            self.psql(database, "SELECT pg_stat_statements_reset()")
            before = {name: container_cpu(name) for name in [self.db, *self.apps]}
            measure = self.phase(out, "measure", seconds, seed, redirects, creates, origins, database)
            ended = time.monotonic()
            after = {name: container_cpu(name) for name in [self.db, *self.apps]}
            expected = baseline + measure["redirect"]["success"] + 2
            drained = []
            for delay in (0, 2, 5, 10, 20, 40, 60):
                time.sleep(max(0, ended + delay - time.monotonic()))
                drained.append(dict(seconds=round(time.monotonic() - ended, 3), hits=self.hits(database)))
                if drained[-1]["hits"] >= expected:
                    break
            audit = dict(baseline=baseline, baseline_stable=baseline_stable, minimum_expected=expected, drain=drained)
            file_json(out / "hit-audit.json", audit)
            file_json(out / "container-cpu.json", {name: {key: value - before[name].get(key, 0)
                                                          for key, value in stats.items()}
                                                   for name, stats in after.items()})
            time.sleep(1)
            probes = [call(["curl", "--noproxy", "*", "-fsS", "--max-time", "4", origin + "/metrics"], check=False)
                      for origin in origins]
            for i, prom in enumerate(probes):
                (out / f"app-{i}.prom").write_text(prom + "\n")
            for i, app in enumerate(self.apps):
                logs = subprocess.run(["docker", "logs", "--tail", "200", app], capture_output=True, text=True)
                (out / f"app-{i}.log").write_text(logs.stdout + logs.stderr)
            stored = self.psql(database, 'SELECT count(*), sum("hitCount") FROM "Url"')
            (out / "db-counts.txt").write_text(stored + "\n")
            statements = self.psql(database, """
SELECT calls, rows, total_exec_time, mean_exec_time, shared_blks_hit, shared_blks_read,
       blk_read_time, blk_write_time, wal_bytes, regexp_replace(query, '[[:space:]]+', ' ', 'g') AS query
FROM pg_stat_statements ORDER BY total_exec_time DESC;""", csv=True)
            (out / "db-statements.csv").write_text(statements + "\n")
        finally:
            call(["docker", "rm", "-fv", *self.apps], check=False)
            self.psql("bench", f"DROP DATABASE IF EXISTS {database} WITH (FORCE)")
        valid = (measure["client_cpu_p95"] < .80
                 and measure.get("client_schedule_lag_p99_ms", 0) < 5
                 and measure.get("client_late", 0) == 0
                 and (not self.args.scheduled_latency or measure.get("client_schedule_lag_p999_ms", 0) < 20))
        passed = all([
            valid, measure["exit"] == 0, measure["dropped"] == 0,
            measure["redirect"]["completed"] == measure["redirect"]["offered"],
            measure["shorten"]["completed"] == measure["shorten"]["offered"],
        ])
        result = dict(index=index, stage=stage, rps=rate, seed=seed, valid=valid, passed=passed,
                      warmup_seconds=warmup, warmup_rps=warm_rate, measure_seconds=seconds, warmup=pre, measure=measure,
                      db_stored=stored, hit_audit=audit, elapsed_sec=round(time.monotonic() - phase_begin, 2))
        self.trials.append(result)
        file_json(out / "trial.json", result)
        file_json(self.out / "trials.json", self.trials)
        cpu = {
            slot: {
                "seconds": round((after[name]["usage_usec"] - before[name]["usage_usec"]) / 1e6, 3),
                "throttled_periods": after[name]["nr_throttled"] - before[name]["nr_throttled"],
                "periods": after[name]["nr_periods"] - before[name]["nr_periods"],
            }
            for slot, name in zip(("db", "app_a", "app_b"), (self.db, *self.apps))
        }
        summary = dict(index=index, stage=stage, rate=rate, valid=valid, passed=passed, cpu=cpu, hit_audit=audit, **measure)
        print("TRIAL " + json.dumps(summary, separators=(",", ":")), flush=True)
        return result

    def valid_trial(self, rate, stage, seed=None, evidence=None):
        for _ in range(self.args.retry_invalid + 1):
            result = self.trial(rate, stage, seed)
            if evidence is not None:
                evidence.append(result)
            if result["valid"]:
                break
        return result

    def explore(self):
        low, high = None, None
        invalid = []
        for rate in self.args.coarse:
            result = self.valid_trial(rate, "coarse")
            if not result["valid"]:
                invalid.append(rate)
                continue
            if not result["passed"]:
                high = rate
                if low is None:
                    for previous in (3600, 3200, 2800, 2400, 1500, 800, 450, 300, 200):
                        if previous >= rate:
                            continue
                        lower = self.valid_trial(previous, "coarse")
                        if lower["valid"] and lower["passed"]:
                            low = previous
                            break
                        if lower["valid"]:
                            high = previous
                break
            low = rate
        upper = high if high is not None else min((v for v in invalid if low is not None and v > low), default=None)
        visited = set(invalid)
        tries = 0
        while low is not None and upper is not None and upper - low > self.args.grid and tries < self.args.max_refine:
            middle_grid = range(((low // self.args.grid) + 1) * self.args.grid, upper, self.args.grid)
            remaining = [rate for rate in middle_grid if rate not in visited]
            if not remaining:
                break
            middle = min(remaining, key=lambda rate: abs(rate - (low + upper) / 2))
            visited.add(middle)
            tries += 1
            result = self.valid_trial(middle, "refine")
            if result["valid"] and result["passed"]:
                low = middle
            elif result["valid"]:
                upper = middle
                high = middle
            else:
                invalid.append(middle)
        return low, high, invalid

    def confirm(self, candidate, neighbor):
        if candidate is None:
            return {}
        levels = [candidate] if neighbor is None or neighbor <= candidate else [candidate, neighbor]
        results = {value: [] for value in levels}
        for repeat in range(self.args.repeats):
            seed = self.design.randrange(2**32)
            order = levels if repeat % 2 == 0 else levels[::-1]
            for rate in order:
                self.valid_trial(rate, "confirm", seed, results[rate])
        def fully_passed(rate):
            valid = [row for row in results[rate] if row["valid"]]
            return len(valid) == self.args.repeats and all(row["passed"] for row in valid)
        while (not self.args.verify_only and candidate >= 200
               and not any(fully_passed(rate) for rate in results) and len(results) < 4):
            candidate -= self.args.grid
            results[candidate] = []
            for _ in range(self.args.repeats):
                self.valid_trial(candidate, "confirm", evidence=results[candidate])
        if (not self.args.verify_only and neighbor is not None and neighbor in results
                and fully_passed(neighbor) and len(results) < 4):
            above = neighbor + self.args.grid
            results[above] = []
            for _ in range(self.args.repeats):
                self.valid_trial(above, "confirm", evidence=results[above])
        return {rate: {"pass": sum(row["passed"] for row in runs), "valid": sum(row["valid"] for row in runs),
                       "runs": len(runs), "indices": [row["index"] for row in runs]} for rate, runs in results.items()}

    def clean(self):
        call(["docker", "rm", "-fv", *self.apps, self.db], check=False)
        call(["docker", "network", "rm", self.net], check=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--db-image", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--k6", default="k6")
    parser.add_argument("--cpus", help="ordered app A, app B, DB and one or more client CPUs")
    parser.add_argument("--explore-warmup", type=int, default=22)
    parser.add_argument("--explore-measure", type=int, default=24)
    parser.add_argument("--warmup", type=int, default=40)
    parser.add_argument("--measure", type=int, default=75)
    parser.add_argument("--repeats", type=int, default=4)
    parser.add_argument("--rate", type=int, help="run one discovery trial instead of the full study")
    parser.add_argument("--verify-rates", help="confirm one or two specified RPS values")
    parser.add_argument("--explore-rates", help="comma-separated ascending discovery RPS values")
    parser.add_argument("--explore-only", action="store_true")
    parser.add_argument("--grid", type=int, default=GRID)
    parser.add_argument("--warmup-rate", type=int, default=0)
    parser.add_argument("--retry-invalid", type=int, default=0)
    parser.add_argument("--max-refine", type=int, default=16)
    parser.add_argument("--bridge", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--redirect-inflight", type=int, default=850)
    parser.add_argument("--shorten-inflight", type=int, default=125)
    parser.add_argument("--scheduled-latency", action="store_true")
    args = parser.parse_args()
    args.coarse = CLOSEST_RPS
    if args.explore_rates:
        args.coarse = tuple(int(value) for value in args.explore_rates.split(","))
        if tuple(sorted(set(args.coarse))) != args.coarse or not all(100 <= rate <= 20000 for rate in args.coarse):
            raise ValueError("Use distinct ascending discovery rates between 100 and 20000")
    lab = Lab(args)
    try:
        lab.start()
        if args.rate:
            lab.trial(args.rate, "probe")
        else:
            if args.verify_rates:
                rates = sorted(set(int(rate) for rate in args.verify_rates.split(",")))
                if len(rates) not in (1, 2) or not all(100 <= rate <= 20000 for rate in rates):
                    raise ValueError("Provide one or two RPS values between 100 and 20000")
                low, neighbor = (rates[0], rates[1] if len(rates) == 2 else None)
                high, invalid = None, []
            else:
                low, high, invalid = lab.explore()
                neighbor = high if high is not None and low is not None and high > low else None
                if neighbor is None and low is not None:
                    neighbor = min((value for value in invalid if value > low), default=None)
            if args.explore_only:
                result = dict(grid_rps=args.grid, exploration_pass=low, exploration_slo_fail=high,
                              exploration_invalid=invalid, verify_neighbor=neighbor)
                file_json(lab.out / "result.json", result)
                print("DISCOVERY " + json.dumps(result, separators=(",", ":")), flush=True)
                return
            results = lab.confirm(low, neighbor)
            winners = [rate for rate, result in results.items() if result["pass"] == result["valid"] == args.repeats]
            result = dict(grid_rps=args.grid, exploration_pass=low, exploration_slo_fail=high,
                          exploration_invalid=invalid, confirmed=max(winners, default=None), confirmation=results)
            file_json(lab.out / "result.json", result)
            print("RESULT " + json.dumps(result, separators=(",", ":")), flush=True)
    finally:
        lab.clean()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(143)))
    main()
