#!/usr/bin/env bash
# Run AFTER `vercel build --cwd apps/<app>` and BEFORE `vercel deploy --prebuilt`.
# npm workspaces install @healtheat/shared as a symlink in the repo-root node_modules. Vercel's
# builders record it in the function's filePathMap as "node_modules/@healtheat/shared" relative
# to the app directory, and the prebuilt deploy refuses a path that is missing or that resolves
# outside the app ("must be inside the uploaded project"). So this copies the built package into
# apps/<app>/node_modules/@healtheat/shared as real files. Usage: scripts/vendor-shared.sh api
set -euo pipefail
app="${1:?app name (api|web)}"
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/packages/shared"
dst="$root/apps/$app/node_modules/@healtheat/shared"
[ -d "$src/dist" ] || (cd "$root" && npm run build:shared)
rm -rf "$dst" && mkdir -p "$dst"
cp -R "$src/package.json" "$src/dist" "$dst/"
echo "vendored @healtheat/shared into apps/$app/node_modules"
