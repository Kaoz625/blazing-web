#!/bin/bash
# Package the web app for LG webOS (.ipk) and Samsung Tizen (.wgt).
#
# Both packages are built from a STAGED COPY, never from this folder directly.
# The old version of this script packaged `.`, which put the smoke tests, the
# patch scripts and node_modules inside the app that ships to a television.
#
# Two things learned the hard way on 27 Aug 2026, both of which stopped the
# build outright:
#
#   1. ares-package's bundled minifier is old and cannot parse modern syntax.
#      app.js uses optional chaining (`state.selected?.id`), so it died with
#      "Failed to minify code" and named app.js as if the file were broken. It
#      is not. --no-minify is the fix; these files are already small and are
#      served from local storage on the TV, not over a network.
#   2. admin.js is dead code — nothing in index.html loads it, and it imports
#      `getConfig` from locker.js, which exports no such thing. It is excluded
#      rather than shipped, because a broken module inside a TV package is a
#      trap for whoever wires it up next.
#
# Requires (install once):
#   npm i -g @webosose/ares-cli                      # LG   -> ares-package
#   ~/tizen-studio/tools/ide/bin/tizen               # Samsung -> tizen
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
STAGE="$(mktemp -d)"
OUT="$ROOT/dist"
TIZEN="${TIZEN_CLI:-$HOME/tizen-studio/tools/ide/bin/tizen}"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUT"

# The app, and only the app. Keep this list in step with what Cloudflare Pages
# is given, so the TV app and the website cannot drift apart.
rsync -a \
  --exclude '.git' --exclude '.wrangler' --exclude 'node_modules' \
  --exclude 'dist' --exclude '*.smoke.mjs' --exclude 'patch*.py' \
  --exclude 'build-tvs.sh' --exclude '.DS_Store' --exclude 'admin.js' \
  "$ROOT"/ "$STAGE"/

echo "staged $(find "$STAGE" -type f | wc -l | tr -d ' ') files"

# ── LG webOS ────────────────────────────────────────────────────────────────
if command -v ares-package >/dev/null 2>&1; then
  ares-package "$STAGE" -o "$OUT" --no-minify
  echo "OK  LG webOS: $(ls "$OUT"/*.ipk | tail -1)"
else
  echo "SKIP  LG webOS — ares-package not found. npm i -g @webosose/ares-cli"
fi

# ── Samsung Tizen ───────────────────────────────────────────────────────────
# A .wgt MUST be signed; an unsigned zip renamed .wgt is rejected by the TV.
# Create the profile once:
#   $TIZEN certificate -a Blazing -f BlazingCert -p <pw> -- ~/tizen-studio-data
#   $TIZEN security-profiles add -n BlazingCert -a <author.p12> -p <pw>
if [ -x "$TIZEN" ]; then
  if "$TIZEN" security-profiles list 2>/dev/null | grep -q BlazingCert; then
    cp "$ROOT/config.xml" "$STAGE/config.xml"
    "$TIZEN" build-web -- "$STAGE" >/dev/null
    "$TIZEN" package -t wgt -s BlazingCert -o "$OUT" -- "$STAGE/.buildResult"
    echo "OK  Samsung Tizen: $(ls "$OUT"/*.wgt | tail -1)"
  else
    echo "SKIP  Samsung Tizen — no BlazingCert security profile yet (see above)."
  fi
else
  echo "SKIP  Samsung Tizen — tizen CLI not at $TIZEN"
fi

echo
echo "Installing on a TV on THIS network:"
echo "  LG       ares-setup-device --add tv --info \"host=<tv-ip>,port=9922,username=prisoner\""
echo "           ares-install --device tv $OUT/*.ipk"
echo "  Samsung  ~/tizen-studio/tools/sdb connect <tv-ip>:26101"
echo "           $TIZEN install -n \$(basename "$OUT"/*.wgt) -- $OUT"
echo
echo "A TV on ANOTHER network cannot be reached by either tool. Open the site in"
echo "the TV's own browser instead: https://blazing-web.pages.dev"
