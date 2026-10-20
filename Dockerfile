FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@11.25.0 --no-audit --no-fund && pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY web ./web
COPY server ./server
RUN pnpm build
RUN mkdir -p /app/backups && chown -R node:node /app/backups
USER node
ENV HOST=0.0.0.0
EXPOSE 8787
CMD ["pnpm", "start"]
