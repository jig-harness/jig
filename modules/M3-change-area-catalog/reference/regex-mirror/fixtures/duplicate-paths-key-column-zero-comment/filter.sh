#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog's web-app area has
# paths: declared twice, with a column-zero YAML comment in between.
# Comments don't affect YAML structure at any indentation, so a real
# parser still sees a duplicate key (commonly resolving to only the last
# value, rogue/**) — but an areas:-block exit condition that treats any
# column-zero line as ending the block, comments included, would stop
# scanning before the second paths: key and validate only the first,
# harmless one. Must be a hard error, not silently unioned or truncated.
CODE_PATH_RE='^apps/'
