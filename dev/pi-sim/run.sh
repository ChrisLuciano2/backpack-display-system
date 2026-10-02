#!/bin/bash
# Helper for the virtual Pi. Run from anywhere:
#   bash dev/pi-sim/run.sh build              build the image (first time, downloads packages)
#   bash dev/pi-sim/run.sh test               run the race scenario against the code in this repo
#   bash dev/pi-sim/run.sh scenario <name>    run any scenario in dev/pi-sim/scenarios (race, testtarget, ...)
#   bash dev/pi-sim/run.sh test-baseline      same, against the ORIGINAL server code (git main)
#   bash dev/pi-sim/run.sh up                 start the virtual Pi and leave it running
#   bash dev/pi-sim/run.sh phone '<json>'...  send commands from a fake phone to the running one
#   bash dev/pi-sim/run.sh down               stop it
set -e
export MSYS_NO_PATHCONV=1   # keep Git Bash from rewriting container paths on Windows

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
if command -v cygpath >/dev/null 2>&1; then REPO_MOUNT="$(cygpath -w "$REPO")"; HERE_WIN="$(cygpath -w "$HERE")"; else REPO_MOUNT="$REPO"; HERE_WIN="$HERE"; fi
IMAGE=backpack-pi-sim
NAME=backpack-pi-sim-run

case "$1" in
  build)
    docker build -t "$IMAGE" "$HERE_WIN"
    ;;
  test)
    docker run --rm -v "$REPO_MOUNT:/app:ro" -v "$HERE_WIN/scenarios:/opt/sim/scenarios:ro" "$IMAGE" scenario race
    ;;
  scenario)
    docker run --rm -v "$REPO_MOUNT:/app:ro" -v "$HERE_WIN/scenarios:/opt/sim/scenarios:ro" "$IMAGE" scenario "$2"
    ;;
  test-baseline)
    TMP="$(mktemp -d)"
    git -C "$REPO_MOUNT" archive main server | tar -x -C "$TMP"
    if command -v cygpath >/dev/null 2>&1; then TMP_MOUNT="$(cygpath -w "$TMP")"; else TMP_MOUNT="$TMP"; fi
    docker run --rm -v "$TMP_MOUNT:/app:ro" "$IMAGE" scenario race || true
    rm -rf "$TMP"
    ;;
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p 127.0.0.1:8080:8080 -p 127.0.0.1:8081:8081 -v "$REPO_MOUNT:/app:ro" -v "$HERE_WIN/scenarios:/opt/sim/scenarios:ro" "$IMAGE" server
    echo "started $NAME. Logs: docker logs -f $NAME"
    ;;
  phone)
    shift
    docker exec "$NAME" node /opt/sim/phone.js "$@"
    ;;
  down)
    docker rm -f "$NAME"
    ;;
  *)
    sed -n '2,10p' "$0"
    ;;
esac
