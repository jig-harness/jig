#!/usr/bin/env bash
# Regresses a fail-open bug: an empty path string (paths: [""]) violates the
# schema's non-empty-string requirement and must be a hard error for the
# whole run, even though a second, unrelated area declares a valid path
# that alone would make PATH_GLOBS non-empty.
CODE_PATH_RE='^apps/'
