#!/usr/bin/env bash
# Pack the built checkout, install the tarball into an empty project, and check
# that the installed CLI starts and serves the app on loopback.
set -euo pipefail

work="${RUNNER_TEMP:-$(mktemp -d)}/pi-web-dock-package"
rm -rf "$work"
mkdir -p "$work/pack" "$work/app" "$work/home"
npm pack --pack-destination "$work/pack" >/dev/null
tarball="$(ls "$work"/pack/pi-web-dock-*.tgz)"

cd "$work/app"
npm init -y >/dev/null
npm install --no-audit --no-fund "$tarball"
npx --no-install pi-web-dock --help | grep -q "Usage: pi-web-dock"

port=30151
HOME="$work/home" USERPROFILE="$work/home" PI_WEB_NO_OPEN=1 PI_WEB_SKIP_VERSION_CHECK=1 \
  npx --no-install pi-web-dock --port "$port" > "$work/server.log" 2>&1 &
server=$!
ready=""
for _ in $(seq 1 90); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$port/"; then ready=1; break; fi
  sleep 2
done
kill "$server" 2>/dev/null || true
if [ -z "$ready" ]; then
  cat "$work/server.log"
  exit 1
fi
echo "pi-web-dock served http://127.0.0.1:$port/"
