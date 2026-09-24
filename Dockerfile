# Dynamic Barcode Management - container image.
# NOTE: written carefully but NOT executed while this project was built (Docker was not available on
# the development machine). Build it once in your environment and check /healthz before relying on it.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY db ./db
COPY scripts ./scripts
RUN mkdir -p storage/logs storage/backups && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

# AUTO_MIGRATE=true (see docker-compose.yml) applies pending migrations at start-up.
CMD ["node", "src/server.js"]
