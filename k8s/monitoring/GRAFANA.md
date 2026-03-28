# Grafana Walkthrough

This guide assumes:
- your app is running in Kubernetes
- `kube-prometheus-stack` is installed
- `url-shortener` and `postgres-exporter` `ServiceMonitor` objects are applied

If those pieces are not in place yet, run the steps in [README.md](/home/alphacent/urlshortener/k8s/monitoring/README.md) first.

## 1. Install the Monitoring Stack

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --version 82.12.0 \
  -f k8s/monitoring/kube-prometheus-stack-values.yaml \
  --wait

kubectl apply -f k8s/monitoring/url-shortener-servicemonitor.yaml
kubectl apply -f k8s/monitoring/postgres-exporter-servicemonitor.yaml
```

If PostgreSQL exporter is not installed yet, install it as well:

```bash
kubectl apply -f k8s/monitoring/postgres-exporter-secret.example.yaml

helm upgrade --install postgres-exporter prometheus-community/prometheus-postgres-exporter \
  --namespace monitoring \
  --version 7.5.0 \
  -f k8s/monitoring/postgres-exporter-values.yaml \
  --wait
```

## 2. Check That Prometheus Sees the Targets

```bash
kubectl get servicemonitors -A
kubectl get pods -n monitoring
```

Then port-forward Prometheus if you want to inspect targets directly:

```bash
kubectl port-forward -n monitoring svc/monitoring-kube-prometheus-prometheus 9090:9090
```

Open `http://localhost:9090/targets` and confirm these targets are `UP`:
- `url-shortener`
- `postgres-exporter`

## 3. Open Grafana

Get the admin password:

```bash
kubectl get secret -n monitoring monitoring-grafana -o jsonpath='{.data.admin-password}' | base64 -d && echo
```

Port-forward Grafana:

```bash
kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80
```

Open `http://localhost:3000`.

Login:
- Username: `admin`
- Password: output from the command above

The Helm chart usually provisions Prometheus as a datasource automatically. Check it here:
- `Connections`
- `Data sources`
- confirm `Prometheus` exists

If it does not exist, add one manually:
- Type: `Prometheus`
- URL: `http://monitoring-kube-prometheus-prometheus.monitoring.svc.cluster.local:9090`
- Access: default is usually fine
- Click `Save & test`

## 4. Import the Recommended Dashboards

In Grafana:
- Click `Dashboards`
- Click `New`
- Click `Import`
- Paste the dashboard ID
- Click `Load`
- Pick the `Prometheus` datasource
- Click `Import`

Recommended dashboard IDs:
- `18575` NodeJS Application Dashboard Kubernetes
- `11159` NodeJS Application Dashboard
- `14114` PostgreSQL Exporter Quickstart and Dashboard
- `12273` PostgreSQL Overview (Postgres_exporter)
- `15757` Kubernetes / Views / Global
- `15759` Kubernetes / Views / Nodes
- `15760` Kubernetes / Views / Pods

There is also a local dashboard JSON in this repo:
- `k8s/monitoring/url-shortener-benchmark-dashboard.json`

To import the local JSON:
- Click `Dashboards`
- Click `New`
- Click `Import`
- Click `Upload dashboard JSON file`
- Choose `k8s/monitoring/url-shortener-benchmark-dashboard.json`
- Pick the `Prometheus` datasource
- Click `Import`

Use them like this:
- NodeJS dashboards: app CPU, heap, event loop, request latency
- PostgreSQL dashboards: query load, locks, transactions, cache hit, connections
- Kubernetes dashboards: pod saturation, node pressure, restarts, network

## 5. Build a Small Custom Performance Dashboard

The imported dashboards are useful, but for benchmark runs you should make one compact dashboard with only the signals you care about.

Suggested panels for the app:

`App RPS`
```promql
sum(rate(http_requests_total{service="url-shortener"}[1m]))
```

`Redirect p95`
```promql
histogram_quantile(
  0.95,
  sum by (le) (
    rate(http_request_duration_seconds_bucket{route="/r/:code",status_code="302"}[5m])
  )
)
```

`Shorten p95`
```promql
histogram_quantile(
  0.95,
  sum by (le) (
    rate(http_request_duration_seconds_bucket{route="/shorten"}[5m])
  )
)
```

`Store findByCode p95`
```promql
histogram_quantile(
  0.95,
  sum by (le) (
    rate(store_operation_duration_seconds_bucket{operation="findByCode",status="success"}[5m])
  )
)
```

`Store incrementHit p95`
```promql
histogram_quantile(
  0.95,
  sum by (le) (
    rate(store_operation_duration_seconds_bucket{operation="incrementHit",status="success"}[5m])
  )
)
```

`Store create p95`
```promql
histogram_quantile(
  0.95,
  sum by (le) (
    rate(store_operation_duration_seconds_bucket{operation="create",status="success"}[5m])
  )
)
```

`App 5xx rate`
```promql
sum(rate(http_requests_total{service="url-shortener",status_code=~"5.."}[1m]))
```

Suggested panels for Node.js runtime:

`Process CPU`
```promql
sum(rate(process_cpu_seconds_total{service="url-shortener"}[1m]))
```

`Resident Memory`
```promql
sum(process_resident_memory_bytes{service="url-shortener"})
```

`Event Loop Lag p95`
```promql
histogram_quantile(
  0.95,
  sum by (le) (
    rate(nodejs_eventloop_lag_seconds_bucket{service="url-shortener"}[5m])
  )
)
```

Suggested panels for PostgreSQL:

`Active connections`
```promql
sum(pg_stat_activity_count{datname="urlshortener",state="active"})
```

`Transactions per second`
```promql
sum(rate(pg_stat_database_xact_commit{datname="urlshortener"}[1m]))
+ sum(rate(pg_stat_database_xact_rollback{datname="urlshortener"}[1m]))
```

`Rows fetched per second`
```promql
sum(rate(pg_stat_database_tup_fetched{datname="urlshortener"}[1m]))
```

`Cache hit ratio`
```promql
sum(rate(pg_stat_database_blks_hit{datname="urlshortener"}[5m]))
/
(
  sum(rate(pg_stat_database_blks_hit{datname="urlshortener"}[5m]))
  +
  sum(rate(pg_stat_database_blks_read{datname="urlshortener"}[5m]))
)
```

`Long running transactions`
```promql
sum(pg_long_running_transactions)
```

`Locks waiting`
```promql
sum(pg_locks_count{granted="false"})
```

## 6. What to Look At During a Benchmark

When `k6` latency gets worse, inspect these panels in order:

1. `http_request_duration_seconds` for `/r/:code` and `/shorten`
2. `store_operation_duration_seconds` for `findByCode`, `incrementHit`, `create`
3. `process_cpu_seconds_total`, memory, event loop lag
4. PostgreSQL connections, TPS, lock waits, cache hit ratio
5. Kubernetes pod CPU throttling, restarts, node pressure

That sequence tells you whether the slowdown is:
- app handler overhead
- a specific store query
- Node.js runtime pressure
- PostgreSQL pressure
- cluster-level resource saturation
