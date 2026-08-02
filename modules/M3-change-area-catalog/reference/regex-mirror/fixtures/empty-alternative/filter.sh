#!/usr/bin/env bash
# Regresses a silent-skip bug: `.*` normalizes to an empty prefix, but the
# actual regex it came from matches every path — that must be a hard error,
# not a silently ignored alternative.
CODE_PATH_RE='^apps/|.*'
