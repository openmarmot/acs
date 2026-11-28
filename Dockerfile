# Node.js 22 LTS. ACS needs the built-in node:sqlite module (Node 22 or newer).
FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

# pnpm-workspace.yaml sets minimumReleaseAge to 14 days. The frozen lockfile
# was resolved under that rule, and this install enforces it again.
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

ENV NODE_ENV=production \
    ACS_DB=/app/data/acs.db \
    PORT=8787 \
    HOST=0.0.0.0 \
    NODE_NO_WARNINGS=1

EXPOSE 8787

# Exec form: the Node process receives SIGTERM and flushes the sim clock.
CMD ["node", "apps/server/dist/index.js"]
