# syntax=docker/dockerfile:1

# ---- Build the web console ---------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Build the API (TypeScript → dist) ----------------------------------------
FROM node:22-alpine AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# ---- Runtime: production deps + compiled output only -------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    WEB_DIR=/app/web/dist \
    REPORTS_DIR=/app/reports
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server/dist ./dist
COPY --from=web /app/web/dist /app/web/dist
COPY server/drizzle ./drizzle
COPY data /app/data
RUN mkdir -p /app/reports && chown node:node /app/reports

USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
# On start: apply migrations, seed idempotently, ingest the KB, then serve API + console.
CMD ["node", "dist/index.js"]
