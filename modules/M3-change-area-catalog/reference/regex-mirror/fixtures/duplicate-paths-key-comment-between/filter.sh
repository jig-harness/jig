#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog's web-app area has
# paths: declared twice, with a 2-space YAML comment in between. A
# comment doesn't end the current mapping in YAML, so a real parser still
# sees a duplicate key (commonly resolving to only the last value,
# rogue/**) — but a duplicate-key tracker that resets on any 2-space,
# non-space-starting line would wrongly treat the comment as a new area
# boundary and let both declarations through unioned. Must be a hard
# error, not silently unioned.
CODE_PATH_RE='^apps/'
