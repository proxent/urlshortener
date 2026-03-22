# Observability Stack

This directory contains the manifests and Helm values needed to observe the URL shortener during k6 load tests on OKE.

Verified against upstream chart metadata on 2026-03-22:
- `kube-prometheus-stack` chart `82.12.0`
- `prometheus-postgres-exporter` chart `7.5.0`

## 1. Install kube-prometheus-stack

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --version 82.12.0 \
  -f k8s/monitoring/kube-prometheus-stack-values.yaml \
  --wait
```

This values file keeps Grafana and Prometheus data on PVCs and allows Prometheus to discover `ServiceMonitor` objects across namespaces.

## 2. Apply the app ServiceMonitor

The OKE Service at `k8s/oke/service.yaml` now exposes a named `http` port, which the `ServiceMonitor` uses.

```bash
kubectl apply -f k8s/monitoring/url-shortener-servicemonitor.yaml
```

## 3. Prepare PostgreSQL for query and connection metrics

Before deploying the exporter:
- Ensure PostgreSQL is started with `shared_preload_libraries = 'pg_stat_statements'`
- Restart PostgreSQL after changing `shared_preload_libraries`
- If you run PostgreSQL 14+, leave `compute_query_id` at `auto` or set it to `on`
- Run the SQL in `k8s/monitoring/postgresql-observability.sql`

## 4. Deploy postgres-exporter

Edit `k8s/monitoring/postgres-exporter-secret.example.yaml` with the real in-cluster DSN for the database where `pg_stat_statements` is installed, then apply it:

```bash
kubectl apply -f k8s/monitoring/postgres-exporter-secret.example.yaml

helm upgrade --install postgres-exporter prometheus-community/prometheus-postgres-exporter \
  --namespace monitoring \
  --version 7.5.0 \
  -f k8s/monitoring/postgres-exporter-values.yaml \
  --wait

kubectl apply -f k8s/monitoring/postgres-exporter-servicemonitor.yaml
```

The exporter values file enables:
- Locks
- Long-running transactions
- `pg_stat_statements`
- A collection timeout so a slow database does not pile up exporter connections

`--collector.stat_statements.include_query` is intentionally left commented out. It adds raw query text as a label and can create very high Prometheus cardinality during aggressive tests.

## 5. Grafana access

Retrieve the generated Grafana admin password:

```bash
kubectl get secret -n monitoring monitoring-grafana -o jsonpath='{.data.admin-password}' | base64 -d && echo
```

Port-forward Grafana locally:

```bash
kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80
```

Import these dashboard IDs:
- `18575` NodeJS Application Dashboard Kubernetes
- `11159` NodeJS Application Dashboard
- `14114` PostgreSQL Exporter Quickstart and Dashboard
- `12273` PostgreSQL Overview (Postgres_exporter)
- `15757` Kubernetes / Views / Global
- `15759` Kubernetes / Views / Nodes
- `15760` Kubernetes / Views / Pods

## 6. Verify targets

Check that Prometheus sees all scrape targets:

```bash
kubectl get servicemonitors -A
kubectl get pods -n monitoring
```

In Grafana and Prometheus, the first metrics to validate are:
- `process_` and `nodejs_` series from the app
- `http_request_duration_seconds` and `http_requests_total`
- `pg_` series from postgres-exporter
