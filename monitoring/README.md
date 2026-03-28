# Monitoring Assets

The in-cluster Prometheus/Grafana manifests were removed. The current setup runs Prometheus, Grafana, and `postgres-exporter` on the Jump VM using:

- `docker-compose.yml`
- `prometheus.yml`

This directory now keeps only the cluster-independent assets that are still useful:

- `postgresql-observability.sql` to enable `pg_stat_statements` and the exporter role in PostgreSQL
- `url-shortener-benchmark-dashboard.json` for the benchmark-focused Grafana dashboard
- `GRAFANA.md` for dashboard import and query guidance

## PostgreSQL Setup

Before starting `postgres-exporter` on the Jump VM:

1. Ensure PostgreSQL is started with `shared_preload_libraries = 'pg_stat_statements'`.
2. Restart PostgreSQL after changing `shared_preload_libraries`.
3. If you run PostgreSQL 14+, leave `compute_query_id` at `auto` or set it to `on`.
4. Run `monitoring/postgresql-observability.sql`, adjusting the database name and exporter password for your environment.

## Grafana

For the current Grafana workflow, see `monitoring/GRAFANA.md`.
