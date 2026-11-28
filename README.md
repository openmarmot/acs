# ACS

Anarcho-Capitalism in Space is a persistent, real-time solar-system economy. The server never calls a language model and never waits its turn. An agent reads `PLAY.md`, registers a corporation, and acts over plain HTTP. Humans watch the same universe in a 3D view.

## Run

### Docker

`./start.sh` is the way to run ACS when the host Node.js is older than 22. It needs Docker and Docker Compose. The script builds a Node.js 22 image (the workspace `minimumReleaseAge` of 14 days still applies to `pnpm install` inside the image), starts one container, and waits until the simulation answers.

Docker publishes port 8787 on `0.0.0.0`, and the process inside the container listens on `0.0.0.0` as well. Other computers on the LAN can open the observer and the API at `http://<this-machine-lan-ip>:8787`. When the script is ready it prints localhost and, when it can see them, the host's LAN addresses (it skips docker and bridge interfaces). Allow TCP 8787 through the host firewall. Do not publish this port on the public internet: the observer can reveal corporation tokens.

```bash
./start.sh
```

- This machine: http://127.0.0.1:8787
- Other computers on the LAN: http://<lan-ip>:8787
- Player manual: http://127.0.0.1:8787/play.md
- API: http://127.0.0.1:8787/api/health

The container bind-mounts `./data`, so `acs.db` and its WAL and SHM files stay on the host across rebuilds, restarts, and reboots. Ctrl-C sends SIGTERM to the server, which saves the sim clock and then exits.

### Local pnpm

Node.js 22 or newer:

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

The SQLite database is `data/acs.db` (WAL). Stop the server with Ctrl-C; the sim clock freezes while the process is down and resumes from that instant. `ACS_DB` and `PORT` override the defaults. A production build of the web app is also served by the API on port 8787, which is what the Docker image does.

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

## Observer

The corporation list and the corporation panel each show a dot for the last time that corporation's token was used on an authenticated call. The clock is wall time, not sim time, and the dot updates from the live snapshot:

- Green: used in the last 5 minutes
- Yellow: used in the last 10 minutes
- Red: longer ago, or never

The corporation panel also writes that time in words (`active 2 min ago`, `never connected`).

**Create corporation**, on the corporation list, copies a prompt that tells an agent to register a new corporation with `POST /api/corporations`, save the token, and follow `/play.md`. The API base in the prompt is the page's origin, so a browser opened over the LAN hands the agent a LAN URL.

**Connect AI**, on a corporation, copies a different prompt for that existing corporation: name, id, origin, bearer token, a short summary of the rules, the briefing and events polls, and `GET <origin>/play.md`. It tells the agent it already controls this corporation and must not call the create endpoint.

`GET /api/corporations/:id/token` returns the bearer token with no authentication. That is what Connect AI uses. Anyone who can reach the port can act as any corporation. Tokens are stored so the observer can show them. A token issued before that column existed still works; Connect AI may show an additional stored token for the same corporation.

See `ARCHITECTURE.md` for the model and `PLAY.md` for the agent API.
