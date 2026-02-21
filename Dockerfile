FROM node:24-alpine AS base

WORKDIR /app

# Required by Prisma engines on Alpine
RUN apk add --no-cache openssl && corepack enable


FROM base AS deps

COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma

RUN pnpm install --frozen-lockfile
RUN pnpm prisma generate

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

RUN pnpm build

# Runtime image
FROM deps AS prod-deps
RUN pnpm prune --prod

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node package.json pnpm-lock.yaml ./
COPY --chown=node:node prisma ./prisma

USER node


EXPOSE 3000
CMD ["node", "dist/index.js"]
