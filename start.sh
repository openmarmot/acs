#!/usr/bin/env bash
# Build and run ACS in Docker. The observer and the API listen on 0.0.0.0:8787,
# so this machine and other computers on the LAN can open them.
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

# Published host port. Keep this in step with docker-compose.yml.
port=8787

# One IPv4 address per line. Skips loopback, link-local, and bridge interfaces
# that other computers on the LAN cannot use (docker0, br-*, veth*, virbr*).
lan_ips() {
  local iface addr seen=" "
  emit() {
    local candidate="$1"
    [[ "$candidate" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 0
    [[ "$candidate" =~ ^(127\.|169\.254\.) ]] && return 0
    case "$seen" in
      *" $candidate "*) return 0 ;;
    esac
    seen+="$candidate "
    printf '%s\n' "$candidate"
  }

  if [[ -d /sys/class/net ]]; then
    for iface in /sys/class/net/*; do
      iface="$(basename "$iface")"
      case "$iface" in
        lo|docker*|br-*|veth*|virbr*|cni*|flannel*|tun*|tap*|dummy*|kube*|podman*|vmnet*|vboxnet*) continue ;;
      esac
      if command -v ip >/dev/null 2>&1; then
        while IFS= read -r addr; do
          emit "$addr"
        done < <(ip -4 -o addr show dev "$iface" scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }' || true)
      elif command -v ifconfig >/dev/null 2>&1; then
        while IFS= read -r addr; do
          emit "$addr"
        done < <(ifconfig "$iface" 2>/dev/null | awk '$1 == "inet" { addr=$2; sub(/^addr:/, "", addr); print addr }' || true)
      fi
    done
    return 0
  fi

  if command -v ifconfig >/dev/null 2>&1; then
    while IFS= read -r addr; do
      emit "$addr"
    done < <(ifconfig -a 2>/dev/null | awk '
      /^[a-zA-Z0-9]/ {
        iface=$1
        gsub(/:$/, "", iface)
        skip = (iface ~ /^(lo|docker|br-|veth|bridge|awdl|llw|utun|gif|stf|ap|vmnet|vboxnet|virbr|dummy)/)
      }
      $1 == "inet" && !skip {
        addr=$2
        sub(/^addr:/, "", addr)
        print addr
      }
    ' || true)
    return 0
  fi

  if command -v hostname >/dev/null 2>&1; then
    while IFS= read -r addr; do
      emit "$addr"
    done < <(hostname -I 2>/dev/null | tr ' ' '\n' || true)
  fi
}

echo
echo "ACS is ready."
echo "  Observer   http://127.0.0.1:${port}"
echo "  Playbook   http://127.0.0.1:${port}/play.md"
echo "  API        http://127.0.0.1:${port}/api/health"

lan=()
while IFS= read -r addr; do
  [[ -n "$addr" ]] && lan+=("$addr")
done < <(lan_ips || true)

echo
if [[ ${#lan[@]} -gt 0 ]]; then
  echo "On this LAN (observer, /play.md, and /api):"
  for addr in "${lan[@]}"; do
    echo "  http://${addr}:${port}"
  done
else
  echo "No LAN address detected. Other computers can open http://<this-machine-ip>:${port}"
fi
echo
echo "The universe is stored in ./data (acs.db plus its WAL files)."
echo "Press Ctrl-C to stop. The sim clock is saved on shutdown."
echo

"${compose[@]}" logs -f acs &
logs_pid=$!
set +e
wait "$logs_pid"
set -e
down
