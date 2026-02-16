# URL Shortener

A production-ready URL shortener built with **Node.js**, **TypeScript**, **Express 5**, and **PostgreSQL (Prisma ORM)**.

It supports:

- Creating short links from long URLs
- Redirecting by short code
- Tracking click counts
- Listing created links
- Docker/Kubernetes deployment manifests (including OKE/EKS examples)

## Tech Stack

- Node.js 24
- TypeScript
- Express 5
- Prisma + PostgreSQL
- pnpm
- Docker
- Kubernetes manifests (generic + OKE/EKS variants)

## Project Structure

```text
.
├── src/                # API server source
├── public/             # Simple web UI
├── prisma/             # Prisma schema and migrations
├── scripts/            # Utility scripts (load test, migration helper)
├── k8s/                # Kubernetes manifests
├── eks/                # EKS-specific example
└── Dockerfile
```

## API Endpoints

### `POST /shorten`

Create a short URL.

Request body:

```json
{
  "url": "https://example.com/some/very/long/path"
}
```

Response example (`201`):

```json
{
  "id": 1,
  "originalUrl": "https://example.com/some/very/long/path",
  "code": "Ab12Cd34",
  "shortUrl": "http://localhost:3000/r/Ab12Cd34",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

### `GET /r/:code`

Redirect to original URL (`302`) and increment hit count.

### `GET /links`

Get all shortened links (newest first).

## Environment Variables

Create a `.env` file in the project root.

```bash
NODE_ENV=development
PORT=3000
BASE_URL=http://localhost:3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/urlshortener
```

Notes:

- `BASE_URL` is used to build `shortUrl` in responses.
- In development, if `BASE_URL` is omitted, the app falls back to `http://localhost:${PORT}`.

## Run Locally

### 1) Install dependencies

```bash
pnpm install
```

### 2) Generate Prisma client

```bash
pnpm prisma generate
```

### 3) Run database migrations

```bash
pnpm prisma migrate deploy
```

### 4) Start in development mode

```bash
pnpm dev
```

Then open:

- API: `http://localhost:3000/`
- UI: `http://localhost:3000/`

## Docker

Build and run:

```bash
docker build -t urlshortener .
docker run --rm -p 3000:3000 --env-file .env urlshortener
```

## Quality Checks

```bash
pnpm build
pnpm lint
```

## Load Test

```bash
pnpm loadtest
```

## LinkedIn Posting Checklist

Before posting this project publicly, consider adding:

- A short architecture diagram (API, DB, ingress)
- A demo GIF/video of creating and opening a short URL
- Sample metrics (latency, throughput from `k6`)
- A deployed demo URL (if possible)
- A “What I learned” section in this README
- A roadmap section (custom aliases, expiration, auth, analytics dashboard)

## License

MIT
