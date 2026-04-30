# URL Shortener

A small URL shortener service built with Node.js, Express 5, TypeScript, Prisma, and PostgreSQL.

## What It Does

- Serves a minimal browser UI at `/`
- Creates short links with `POST /shorten`
- Redirects short codes with `GET /r/:code`
- Stores URLs and hit counts in PostgreSQL through Prisma
- Caches redirect targets in-process for faster hot redirects
- Batches hit-count updates so redirects do not wait on every database write
- Exposes `GET /healthz`, `GET /readyz`, and Prometheus-compatible `GET /metrics`
- Ships with Docker Compose, k6 benchmark tooling, monitoring assets, and OKE-focused Kubernetes manifests

## Quick Start

Use Docker Compose when you just want the app and a local PostgreSQL database:

```bash
docker compose up --build
```

Once the containers are healthy:

- Open `http://localhost:3000`
- Check `http://localhost:3000/healthz`
- Create a short URL directly:

```bash
curl -X POST http://localhost:3000/shorten \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'
```

Example response:

```json
{
  "id": 1,
  "originalUrl": "https://example.com",
  "code": "Ab12Cd34",
  "shortUrl": "http://localhost:3000/r/Ab12Cd34",
  "createdAt": "2026-03-10T00:00:00.000Z"
}
```

## Tech Stack

- Node.js, Express 5, TypeScript
- Prisma ORM and PostgreSQL
- pnpm
- Docker and Docker Compose
- Prometheus metrics with `prom-client`
- k6 benchmark scripts
- Kubernetes, Kustomize, Argo CD, and Oracle Kubernetes Engine manifests
- GitHub Actions for CI and OKE image promotion

## Project Layout

```text
src/
  index.ts                 # Server entrypoint
  app.ts                   # Express app factory and health/readiness routes
  routes.ts                # Public API routes and URL validation
  shortenerStore.ts        # Prisma-backed storage and batched hit updates
  cachedShortenerStore.ts  # In-process redirect target cache
  metrics.ts               # Prometheus instrumentation
  config.ts                # Environment parsing and validation
  middleware/              # Error handling and /shorten rate limiting
public/                    # Minimal browser UI
prisma/                    # Prisma schema and migrations
scripts/                   # Migration guard, benchmark, restore, and seed helpers
test/                      # node:test test suite
monitoring/                # Jump VM Prometheus/Grafana assets
k8s/oke/                   # OKE manifests and Kustomize entrypoint
eks/aws.yaml               # Reference eksctl config, not wired into deployment
```

## Configuration

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | Runtime environment: `development`, `production`, or `test` |
| `PORT` | No | `3000` | HTTP port |
| `BASE_URL` | Production: yes | `http://localhost:<PORT>` outside production | Public base URL used in returned `shortUrl` values |
| `DATABASE_URL` | Yes for DB-backed runs | none | PostgreSQL connection string used by Prisma |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate-limit window for `POST /shorten` |
| `RATE_LIMIT_MAX_SHORTEN` | No | `60` | Max shorten requests per window |
| `REDIRECT_CACHE_MAX_ENTRIES` | No | `50000` | Max in-process redirect cache entries |
| `LOADTEST_BYPASS_KEY` | No | empty | Shared secret accepted in `x-loadtest-key` to bypass shorten rate limiting |
| `TRUST_PROXY` | No | `1` in production | Express `trust proxy` setting; accepts `true`, `false`, a number, or a string |

`BASE_URL` must be an absolute `http` or `https` URL. In production it cannot point to `localhost`, `127.0.0.1`, or `::1`.

## Local Development

Install dependencies:

```bash
pnpm install
```

Create a local `.env`:

```env
NODE_ENV=development
PORT=3000
BASE_URL=http://localhost:3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/urlshortener
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_SHORTEN=60
REDIRECT_CACHE_MAX_ENTRIES=50000
TRUST_PROXY=false
```

Apply migrations and start the dev server:

```bash
pnpm prisma migrate deploy
pnpm dev
```

Run tests:

```bash
pnpm test
```

## Docker

`docker compose up --build` starts three services:

- `db`: PostgreSQL 16 with a persistent `postgres-data` volume
- `migrate`: runs `scripts/migrate-if-needed.sh` before the app starts
- `app`: builds the production image and serves on `localhost:3000`

The migration guard checks whether the Prisma `Url` table exists before running `pnpm prisma migrate deploy`.

The production Docker image uses a multi-stage build, prunes dev dependencies, runs as the `node` user, and starts `node dist/index.js`.

## HTTP API

### `GET /`

Serves the browser UI from `public/index.html`.

### `GET /healthz`

Returns `200` when the process is serving traffic:

```json
{ "status": "ok" }
```

### `GET /readyz`

Checks the backing store with a lightweight database query:

- `200` with `{ "status": "ready" }` when PostgreSQL is reachable
- `503` with `{ "status": "not ready" }` when the readiness check fails

### `GET /metrics`

Returns Prometheus text-format metrics, including default Node.js metrics and app request metrics for routed API traffic.

### `POST /shorten`

```http
POST /shorten
Content-Type: application/json

{
  "url": "https://example.com"
}
```

Success returns `201` with the created link and public short URL. Invalid payloads return `400`, rate-limited requests return `429`, and unexpected failures return `500`.

Validation rules:

- `url` must be a string
- Only `http` and `https` URLs are accepted
- URLs longer than 2048 characters are rejected

### `GET /r/:code`

Redirects to the original URL with `302` when the code exists. Unknown codes return `404`.

Redirect target lookups use the in-process cache. Hit-count updates are queued and flushed asynchronously, so the redirect response does not wait for the database increment to finish.

There is no public listing endpoint.

## Scripts

- `pnpm dev`: run the TypeScript app with `ts-node-dev`
- `pnpm build`: run `prisma generate` and compile to `dist/`
- `pnpm start`: run the compiled app
- `pnpm test`: compile tests with `tsconfig.test.json` and run them with `node:test`
- `pnpm lint`: run ESLint on `src/**/*.{ts,tsx}`
- `pnpm lint:fix`: run ESLint with fixes
- `pnpm format`: format `src/**/*.{ts,tsx}` with Prettier
- `pnpm format:check`: check Prettier formatting
- `pnpm loadtest`: run the default k6 scenario in Docker

Operational helpers:

- `scripts/migrate-if-needed.sh`: Docker Compose migration guard
- `scripts/make_seeds.js`: pre-create short codes for load tests
- `scripts/restore-db.sh`: restore a PostgreSQL dump into a benchmark/local database
- `scripts/run-benchmark.sh`: repeatable Jump VM benchmark entrypoint

## Testing, Load Testing, And Monitoring

The test suite covers route behavior, readiness behavior, the redirect cache, unique-code collision retry, and batched hit-count updates.

For load testing:

- `scripts/loadtest.js` defines the k6 traffic model
- `scripts/BENCHMARK.md` documents the repeatable Jump VM benchmark workflow
- `LOADTEST_BYPASS_KEY` can be used with `x-loadtest-key` to avoid measuring shorten rate limiting during load tests

For monitoring:

- The app exposes `/metrics`
- `monitoring/README.md` documents the external Jump VM Prometheus/Grafana setup
- `monitoring/GRAFANA.md` documents dashboard import and query workflow
- `monitoring/postgresql-observability.sql` contains PostgreSQL exporter and `pg_stat_statements` setup helpers

## CI/CD

`.github/workflows/ci-pr.yml` runs on pull requests:

- install dependencies
- run `pnpm test`
- run `pnpm build`

`.github/workflows/oke-cd.yml` is manually triggered with `workflow_dispatch`:

- run tests
- build and push a linux/arm64 image to OCIR
- capture the pushed image digest
- run `kustomize edit set image` in `k8s/oke`
- commit the updated `k8s/oke/kustomization.yaml` back to the current branch

The OKE workflow needs the OCIR secrets configured in GitHub Actions and branch permissions that allow `GITHUB_TOKEN` to push the promotion commit.

## Kubernetes And Argo CD

`k8s/oke/kustomization.yaml` is the Argo CD entrypoint for the OKE app. The Argo CD Application should point its source path at `k8s/oke`.

When Argo CD syncs the Application, it renders the Kustomization and applies the resulting Kubernetes resources. You sync the Argo CD Application, not `kustomization.yaml` as a standalone Kubernetes object.

Included in the Kustomization:

- Namespace
- ConfigMap
- ExternalSecret and SecretStore
- Deployment
- Service
- cert-manager Issuers
- Ingress

Not included in the Kustomization:

- `job-migrate.yaml`: Prisma migration Job kept for manual schema-change operations
- `ingress-nginx.yaml`: Helm values for NGINX Ingress Controller, not a Kubernetes manifest

For normal app deployments, run the OKE image workflow, let it commit the new digest into `kustomization.yaml`, then refresh and sync the Argo CD Application. Run the migration Job separately only for releases that need database schema changes.

## Roadmap

- Add custom aliases and link expiration support
- Add structured logging and tracing
- Expand app-level middleware and Prisma integration coverage
- Add a safe admin/listing surface if operational visibility into created links is needed
- Move production image promotion to a PR-based flow if branch protection should block direct workflow commits
