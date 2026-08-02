#!/usr/bin/env bash
# Regresses a false-agreement bug: a trailing \$ is an escaped literal
# dollar character (matching the path "package$"), not the end-of-string
# anchor — the anchored form ^package$ matches "package" instead. Treating
# \$ as the exact-anchor form would let this falsely pass against a catalog
# declaring the unrelated literal path "package" (no dollar sign). Must be
# a hard error: this alternative has no other recognized boundary.
CODE_PATH_RE='^package\$'
