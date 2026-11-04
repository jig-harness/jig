#!/bin/sh
# The browser the design-handback landing check renders with
# (`design_brief.handback.browser_executable` in .config/jig.yaml): the first
# Chromium-compatible browser this machine has. A machine with its browser
# elsewhere names it in `JIG_CHROMIUM`, or sets the environment layer's
# `JIG__design_brief__handback__browser_executable` for the run.
for candidate in \
  "${JIG_CHROMIUM:-}" \
  /usr/bin/chromium \
  /usr/bin/chromium-browser \
  /usr/bin/google-chrome \
  /usr/bin/google-chrome-stable \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    exec "$candidate" "$@"
  fi
done
echo "tools/design/chromium.sh: no Chromium-compatible browser found; set JIG_CHROMIUM to its path" >&2
exit 127
