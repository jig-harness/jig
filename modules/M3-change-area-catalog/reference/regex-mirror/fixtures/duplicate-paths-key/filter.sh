#!/usr/bin/env bash
# Regresses a false-agreement bug: web-app's paths: key is declared twice
# in the paired catalog. Most lenient YAML parsers accept a duplicate key
# but keep only one value (commonly the last), so a real parser sees only
# rogue/**, not apps/**. Unioning both declarations' globs, as a naive
# per-line scan would, lets ^apps/ pass here even though the resolver can
# never see that glob. Must be a hard error, not silently unioned.
CODE_PATH_RE='^apps/'
