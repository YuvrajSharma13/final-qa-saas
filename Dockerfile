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
RUN npm ci && npx playwright-core install --with-deps chromium && rm -rf /var/lib/apt/lists/*
COPY server/ ./
COPY --from=web /app/web/dist /app/web/dist
ENV WEB_DIST=/app/web/dist STORAGE_DIR=/data/storage PORT=4000
EXPOSE 4000
CMD ["npx", "tsx", "src/index.ts"]
