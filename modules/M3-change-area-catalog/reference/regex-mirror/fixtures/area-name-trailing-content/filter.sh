#!/usr/bin/env bash
# Regresses a fail-open bug: the paired catalog's web-app line has a
# trailing scalar value (web-app: invalid) instead of opening a
# nested mapping. A recognizer that finds any colon and discards
# everything after it, without checking what that content actually
# is, would still treat the indented paths: below as though it were
# genuinely nested under web-app — but a real YAML parser reads
# web-app as a scalar string, not a mapping, making the structure
# invalid. Must be a hard error, mirroring the same check already
# applied to the root areas: key.
CODE_PATH_RE='^apps/'
