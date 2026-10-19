FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@11.25.0 --no-audit --no-fund && pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY web ./web
COPY server ./server
RUN pnpm build
RUN mkdir -p /app/data /app/backups && chown -R node:node /app/data /app/backups
USER node
ENV HOST=0.0.0.0
ENV CRM_DB_PATH=/app/data/crm.db
EXPOSE 8787
CMD ["pnpm", "start"]
