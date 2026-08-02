#!/usr/bin/env bash
# "  - app:" under areas: is a YAML block-sequence entry, not a mapping
# key — a real loader parses this as areas: [{app: null, paths: [...]}],
# a sequence containing one mapping, not the required mapping of named
# areas (verified directly). The resolver never sees a named "app" area to
# resolve against, even though a naive area-line scanner would harvest
# "- app" as if it were a valid (if oddly punctuated) area name. Must be a
# hard error.
CODE_PATH_RE='^apps/'
