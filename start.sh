#!/usr/bin/env bash
# Build and run ACS in Docker. The observer and the API share http://127.0.0.1:8787.
# Ctrl-C (or SIGTERM) stops the container and lets the server save the sim clock.

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install Docker Desktop or Docker Engine, then run ./start.sh again." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed, but the daemon is not running. Start Docker, then run ./start.sh again." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose=(docker-compose)
else
  echo "Docker Compose is not available. Install the Docker Compose plugin (docker compose) and run ./start.sh again." >&2
  exit 1
fi

mkdir -p data

stopped=0
logs_pid=""

down() {
  if [[ "$stopped" -eq 1 ]]; then
    return 0
  fi
  stopped=1
  echo
  echo "Stopping ACS. The server saves the sim clock before it exits."
  if [[ -n "$logs_pid" ]]; then
    kill "$logs_pid" 2>/dev/null || true
  fi
  "${compose[@]}" stop --timeout 20 || true
  "${compose[@]}" down || true
}

trap 'down; exit 0' INT TERM

echo "Building and starting ACS..."
if ! "${compose[@]}" up --build --detach; then
  echo "Failed to start ACS." >&2
  "${compose[@]}" logs --tail 80 >&2 || true
  down
  exit 1
fi

echo "Waiting until the simulation answers..."
ready=0
for _ in $(seq 1 90); do
  cid="$("${compose[@]}" ps -q acs || true)"
  if [[ -n "${cid}" ]] && docker exec "$cid" node -e "fetch('http://127.0.0.1:8787/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" -ne 1 ]]; then
  echo "ACS did not become ready. Recent logs:" >&2
  "${compose[@]}" logs --tail 80 >&2 || true
  down
  exit 1
fi

cat <<'EOF'

ACS is ready.
  Observer   http://127.0.0.1:8787
  Playbook   http://127.0.0.1:8787/play.md
  API        http://127.0.0.1:8787/api/health

The universe is stored in ./data (acs.db plus its WAL files).
Press Ctrl-C to stop. The sim clock is saved on shutdown.

EOF

"${compose[@]}" logs -f acs &
logs_pid=$!
set +e
wait "$logs_pid"
set -e
down
