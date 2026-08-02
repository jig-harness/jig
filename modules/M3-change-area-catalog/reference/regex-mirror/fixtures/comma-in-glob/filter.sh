#!/usr/bin/env bash
# Regresses a comma-splitting bug: a literal comma inside a quoted glob must
# stay part of that one glob, not be split into a spurious extra entry that
# a narrower regex could falsely match.
CODE_PATH_RE='^apps/foo/'
