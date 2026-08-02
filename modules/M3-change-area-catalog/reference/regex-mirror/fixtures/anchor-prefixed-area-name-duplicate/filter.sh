#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog's second app
# area is prefixed with a YAML anchor (&dup app:) — a node property a
# real YAML loader resolves to the same app key regardless of the
# anchor, retaining only the later mapping. A scanner that doesn't
# recognize the anchor-prefixed spelling as this gate's area-name
# form would treat it as a distinct area named "&dup app" (or worse,
# silently mishandle it), letting the duplicate slip past instead of
# rejected — the same hazard already closed for the root areas: key,
# one level deeper. Must be a hard error.
CODE_PATH_RE='^apps/'
