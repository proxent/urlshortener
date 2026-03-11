# URL Shortener

A URL shortener service built with Node.js, Express 5, TypeScript, Prisma, and PostgreSQL.

Current behavior:
- Serves a minimal browser UI at `/` for creating short URLs
- Accepts `POST /shorten` requests with strict URL validation
- Redirects `GET /r/:code` requests and increments hit counts
- Applies configurable rate limiting to the shorten endpoint
- Ships with Docker Compose, k6 load-test tooling, and Kubernetes manifests for generic clusters and OKE

## Tech Stack

- Node.js
- Express 5
- TypeScript
- Prisma ORM
- PostgreSQL
- pnpm
- Docker / Docker Compose
- k6
- Kubernetes

## Project Structure

```text
src/
  index.ts                 # App entrypoint
  app.ts                   # Express app factory
  routes.ts                # API routes and validation
  shortenerStore.ts        # Prisma-backed data access
  prisma.ts                # Prisma client singleton
  config.ts                # Environment parsing and validation
  middleware/
    errorHandler.ts        # Sanitized 500 responses in production
    rateLimit.ts           # /shorten limiter with optional bypass header
  types/
    express.d.ts
public/
  index.html               # Minimal frontend
  app.js                   # Frontend submit/render logic
prisma/
  schema.prisma            # DB schema
  migrations/              # Prisma migrations
scripts/
  migrate-if-needed.sh     # Compose migration guard
  loadtest.js              # k6 scenario
  make_seeds.js            # Generate seed codes for load tests
test/
  routes.test.ts           # Route tests with node:test
k8s/
  app/                     # Generic Kubernetes manifests
  oke/                     # Oracle Kubernetes Engine manifests
eks/
  aws.yaml                 # Example eksctl cluster config
```

## Environment Variables

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `NODE_ENV` | No | `development` | Runtime environment |
| `PORT` | No | `3000` | HTTP port |
| `BASE_URL` | In production | `http://localhost:<PORT>` outside production | Base URL used in returned `shortUrl` values |
| `DATABASE_URL` | Yes for DB-backed runs | - | PostgreSQL connection string |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate-limit window for `POST /shorten` |
| `RATE_LIMIT_MAX_SHORTEN` | No | `60` | Max shorten requests allowed per window |
| `LOADTEST_BYPASS_KEY` | No | empty | Shared secret accepted in the `x-loadtest-key` header to skip rate limiting |
| `TRUST_PROXY` | No | `1` in production, unset otherwise | Express `trust proxy` setting |

Notes:
- `BASE_URL` must be an absolute `http` or `https` URL.
- In production, `BASE_URL` cannot point at `localhost`, `127.0.0.1`, or `::1`.

## Local Development

### 1) Install dependencies

```bash
pnpm install
```

### 2) Configure environment

Create a `.env` file:

```env
NODE_ENV=development
PORT=3000
BASE_URL=http://localhost:3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/urlshortener
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_SHORTEN=60
TRUST_PROXY=false
```

### 3) Apply migrations

```bash
pnpm prisma migrate deploy
```

### 4) Start the dev server

```bash
pnpm dev
```

The app will be available at `http://localhost:3000`.

### 5) Run tests

```bash
pnpm test
```

## Docker Compose

```bash
docker compose up --build
```

This starts:
- `db` for PostgreSQL
- `migrate` to run `scripts/migrate-if-needed.sh`
- `app` for the Express service

Open `http://localhost:3000` after the containers are healthy.

## HTTP Behavior

### `GET /`

Serves the static frontend from `public/index.html`.

### `POST /shorten`

```http
POST /shorten
Content-Type: application/json

{
  "url": "https://example.com"
}
```

Success (`201`):

```json
{
  "id": 1,
  "originalUrl": "https://example.com",
  "code": "Ab12Cd34",
  "shortUrl": "http://localhost:3000/r/Ab12Cd34",
  "createdAt": "2026-03-10T00:00:00.000Z"
}
```

Validation and error behavior:
- Only `http` and `https` URLs are accepted
- URLs longer than 2048 characters are rejected
- Invalid payloads return `400`
- Rate-limited requests return `429`
- Unexpected failures return `500`

### `GET /r/:code`

- Returns a `302` redirect to the original URL when the code exists
- Increments `hitCount` in the database before redirecting
- Returns `404` when the code is unknown

There is currently no public `GET /links` endpoint in the app.

## Scripts

- `pnpm dev` runs the TypeScript app with `ts-node-dev`
- `pnpm build` runs `prisma generate` and compiles to `dist/`
- `pnpm start` runs the compiled app
- `pnpm test` compiles tests with `tsconfig.test.json` and runs them with `node:test`
- `pnpm lint` runs ESLint on `src/**/*.{ts,tsx}`
- `pnpm lint:fix` runs ESLint with fixes
- `pnpm format` formats `src/**/*.{ts,tsx}` with Prettier
- `pnpm format:check` checks formatting
- `pnpm loadtest` runs the default k6 scenario in Docker

## Load Testing

`scripts/loadtest.js` models mixed redirect and shorten traffic, supports hot/cold key distributions, and can optionally bypass the shorten rate limit with `x-loadtest-key`.

Useful helpers:
- `scripts/make_seeds.js` pre-creates short codes and writes them to JSON
- `LOADTEST_BYPASS_KEY` lets load tests avoid being throttled by the app limiter

## CI/CD

- `.github/workflows/ci-pr.yml`
  - Trigger: `pull_request`
  - Runs `pnpm install --frozen-lockfile`, `pnpm test`, and `pnpm build`
- `.github/workflows/oke-cd.yml`
  - Trigger: `workflow_dispatch`
  - Runs tests, builds an ARM64 image, pushes it to OCIR, and prints the image tag for manual deployment sync

## Kubernetes

### `k8s/app/`

Generic manifests for running the app in a cluster:
- Namespace, ConfigMap, and example Secret
- Deployment with non-root security context, probes, and resource requests/limits
- Service and Ingress
- HorizontalPodAutoscaler

### `k8s/oke/`

Oracle Kubernetes Engine-focused manifests:
- OCIR-backed Deployment and separate migration Job
- ConfigMap plus secrets sourced through External Secrets
- `SecretStore` for OCI Vault
- NGINX ingress with TLS enabled through cert-manager `Issuer` resources
- Pod anti-affinity for better placement across nodes

### `eks/aws.yaml`

An example `eksctl` cluster configuration for AWS EKS. It is not wired into the current deployment workflow, but it is kept as a reference starting point.

## Next Improvements

1. Add dedicated health and readiness endpoints instead of relying on `/`
2. Add custom aliases and link expiration support
3. Add structured logging, metrics, and tracing
4. Expand tests to cover app-level middleware behavior and Prisma-backed paths
5. Add a safe admin/listing surface if operational visibility into created links is needed
6. Automate deployment promotion after image build instead of relying on a manual sync step
