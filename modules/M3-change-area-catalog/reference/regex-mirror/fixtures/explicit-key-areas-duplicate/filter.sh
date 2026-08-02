#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog declares the
# top-level areas key a second time using YAML's explicit-key form
# (`? areas` followed by `:` and the replacement mapping) — the same
# areas root key to a real YAML loader as the first bare areas:, just
# spelled a different way. A scanner recognizing only the plain
# `key:` forms doesn't see `? areas` as this gate's areas: key at
# all, so it falls through to whatever handling applies to an
# unrecognized column-zero line and silently ends the block instead
# of flagging the duplicate. Must be a hard error.
CODE_PATH_RE='^apps/'
