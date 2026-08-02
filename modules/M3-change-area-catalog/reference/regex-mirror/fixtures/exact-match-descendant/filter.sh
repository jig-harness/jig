#!/usr/bin/env bash
# Regresses a false-agreement bug: an exact-anchored alternative (^package$)
# matches only the single literal path "package", never anything under a
# descendant like package/index.js. A boundary-prefix match against the
# catalog's package/** (a descendant glob, not the bare literal path) would
# wrongly certify this as covered; it must require exact string equality
# instead, and fail here since no area declares the bare literal "package".
CODE_PATH_RE='^package$'
