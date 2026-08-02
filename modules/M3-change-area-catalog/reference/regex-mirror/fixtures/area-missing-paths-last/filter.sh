#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog's last area,
# core-lib, has no paths: field — the scanner must still catch this even
# though the file simply ends without ever starting a next area or
# leaving the areas: block, the two places the check normally fires. Must
# be a hard error at end of file, not silently skipped because there was
# no later boundary to trigger the check.
CODE_PATH_RE='^apps/'
