# Single image: API + QA engine (Playwright/Chromium) + built web app.
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app/server
COPY server/package*.json ./
# git + CA certificates are required by the GitHub auto-fix engine (clone → branch → commit → push).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && npm ci && npx playwright-core install --with-deps chromium && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/storage /data/autofix-work
COPY server/ ./
COPY --from=web /app/web/dist /app/web/dist
ENV WEB_DIST=/app/web/dist STORAGE_DIR=/data/storage AUTOFIX_WORK_DIR=/data/autofix-work PORT=4000
EXPOSE 4000
CMD ["npx", "tsx", "src/index.ts"]
