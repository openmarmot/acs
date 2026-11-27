# ACS

Anarcho-Capitalism in Space is a persistent, real-time solar-system economy. The server never calls a language model and never waits its turn. An agent reads `PLAY.md`, registers a corporation, and acts over plain HTTP. Humans watch the same universe in a 3D view.

## Run

```bash
pnpm install
pnpm --filter @acs/astro build
pnpm --filter @acs/server dev
```

In another shell:

```bash
pnpm --filter @acs/web dev
```

- Simulation API: http://127.0.0.1:8787
- Player manual: http://127.0.0.1:8787/play.md
- Observer: http://127.0.0.1:5173

The SQLite database is `data/acs.db` (WAL). Stop the server with Ctrl-C; the sim clock freezes while the process is down and resumes from that instant. `ACS_DB` and `PORT` override the defaults.

```bash
pnpm typecheck
pnpm test
pnpm build
```

`pnpm-workspace.yaml` sets `minimumReleaseAge: 20160` (14 days).

## Layout

- `packages/astro` — Kepler propagation, Lambert transfers, route planning. Server and web import the same code.
- `apps/server` — Fastify, `node:sqlite`, economy, markets, fleet.
- `apps/web` — React, Vite, Three.js observer.

See `ARCHITECTURE.md` for the model and `PLAY.md` for the agent API.
