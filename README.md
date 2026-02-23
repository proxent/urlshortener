# URL Shortener

A simple URL shortener service built with **Node.js**, **Express**, **TypeScript**, and **Prisma**.

It provides:
- A REST API to create short URLs.
- Redirect support from short codes to original URLs.
- A basic web UI to create and view links.
- PostgreSQL-backed storage.

## Tech Stack

- Node.js + Express 5
- TypeScript
- Prisma ORM
- PostgreSQL
- pnpm
- Docker / Docker Compose
- Kubernetes manifests (`k8s/`)

## Project Structure

```text
src/
  index.ts                 # App entrypoint
  app.ts                   # Express app factory
  routes.ts                # Router factory
  shortenerStore.ts        # Prisma data access layer
  prisma.ts                # Prisma client singleton
  config.ts                # Environment configuration
  middleware/errorHandler.ts
public/
  index.html               # Minimal frontend UI
prisma/
  schema.prisma            # DB schema
  migrations/              # Prisma migrations
scripts/
  migrate-if-needed.sh
  loadtest.js
test/
  routes.test.ts           # Route tests (node:test)
```

## Environment Variables

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `NODE_ENV` | No | `development` | Runtime environment |
| `PORT` | No | `3000` | Server port |
| `BASE_URL` | No | `http://localhost:<PORT>` in non-production | Base URL used when generating `shortUrl` responses |
| `DATABASE_URL` | Yes (for DB operations) | - | PostgreSQL connection string |

## Local Development (without Docker)

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
```

### 3) Run DB migration

```bash
pnpm prisma migrate deploy
```

### 4) Start development server

```bash
pnpm dev
```

Server runs at `http://localhost:3000`.

### 5) Run tests

```bash
pnpm test
```

## Run with Docker Compose

```bash
docker compose up --build
```

This starts:
- `db` (PostgreSQL)
- `migrate` (Prisma migration job)
- `app` (URL shortener service)

Open `http://localhost:3000` after containers are ready.

## API

### Health / root

```http
GET /
```

Response:

```json
{ "message": "URL Shortener API ready" }
```

### Create short URL

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
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

### Redirect to original URL

```http
GET /r/:code
```

- Redirects with `302` when found.
- Returns `404` if code does not exist.

### List links

```http
GET /links
```

Response:

```json
[
  {
    "id": 1,
    "originalUrl": "https://example.com",
    "code": "Ab12Cd34",
    "shortUrl": "http://localhost:3000/r/Ab12Cd34",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "hitCount": 3
  }
]
```

## Scripts

- `pnpm dev` — run dev server with hot reload.
- `pnpm build` — compile TypeScript to `dist/`.
- `pnpm start` — run compiled app.
- `pnpm test` — compile and run route tests with `node:test`.
- `pnpm lint` — lint TypeScript files.
- `pnpm loadtest` — run k6 load test from Docker.

## CI/CD

- **PR CI** (`.github/workflows/ci-pr.yml`)
  - Trigger: `pull_request`
  - Runs: dependency install + `pnpm test`
- **OKE build/push** (`.github/workflows/oke-cd.yml`)
  - Trigger: `workflow_dispatch`
  - Runs tests before Docker image build/push

## Kubernetes Manifests

This repository includes Kubernetes manifests under:
- `k8s/app/`
- `k8s/postgresql/`
- `k8s/oke/`

There is also an EKS example config in `eks/aws.yaml`.

## What else should you do next?

Recommended next actions:

1. Add authentication/rate limiting
   - Prevent abuse of the shortening endpoint.
2. Add expiration and custom aliases
   - Support links that expire and user-defined short codes.
3. Improve observability
   - Add structured logs, metrics, and tracing.
4. Expand test coverage
   - Add store-level tests and failure-path tests (DB errors, limiter behavior, malformed JSON).
5. Harden production config
   - Validate required environment variables and add health/readiness checks.
6. Strengthen CI/CD
   - Add lint/build checks and container vulnerability scanning in pull requests.
