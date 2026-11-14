#!/usr/bin/env bash
# Pack the built checkout, install the tarball into an empty project, and check
# that the installed CLI starts and serves the app on loopback.
set -euo pipefail

work="${RUNNER_TEMP:-$(mktemp -d)}/pi-web-dock-package"
rm -rf "$work"
mkdir -p "$work/pack" "$work/app" "$work/home"
pack_json="$work/pack.json"
npm pack --json --pack-destination "$work/pack" > "$pack_json"
# npm names a scoped package tarball <scope>-<name>-<version>.tgz.
tarball="$(node - "$pack_json" <<'NODE'
const { readFileSync } = require("node:fs");
const [packJson] = process.argv.slice(2);
const [pack] = JSON.parse(readFileSync(packJson, "utf8"));
if (!pack?.filename || !pack.integrity || !Array.isArray(pack.files)) throw new Error("npm pack metadata is incomplete");
process.stdout.write(pack.filename);
NODE
)"
tarball="$work/pack/$tarball"
node - "$pack_json" "$tarball" <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const [packJson, tarball] = process.argv.slice(2);
const [pack] = JSON.parse(readFileSync(packJson, "utf8"));
const bytes = readFileSync(tarball);
console.log(`package tarball: ${tarball}`);
console.log(`package tarball bytes: ${statSync(tarball).size}`);
console.log(`package tarball sha256: ${createHash("sha256").update(bytes).digest("hex")}`);
console.log(`package tarball npm integrity: ${pack.integrity}`);
console.log(`package tarball file count: ${pack.files.length}`);
NODE

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
