#!/usr/bin/env bash
# Render scripts/og.html to public/og.png at exactly 1200x630.
#
# Headless Chrome's own --screenshot flag does this with no dependency to
# install; --virtual-time-budget is what waits for the webfonts and the
# captures instead of shooting a half-loaded page.
set -euo pipefail
cd "$(dirname "$0")/.."

chrome="${CHROME_PATH:-}"
if [ -z "$chrome" ]; then
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome || true)" \
    "$(command -v chromium || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && chrome="$c" && break
  done
fi
[ -n "$chrome" ] || { echo "no Chrome found — set CHROME_PATH" >&2; exit 1; }

out="$PWD/public/og.png"
"$chrome" --headless --disable-gpu --hide-scrollbars \
  --force-color-profile=srgb --window-size=1200,630 \
  --virtual-time-budget=8000 \
  --screenshot="$out" "file://$PWD/scripts/og.html" 2>/dev/null

echo "wrote public/og.png ($(du -h "$out" | cut -f1))"
