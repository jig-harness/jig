#!/usr/bin/env bash
# Regresses a false-agreement bug: bash joins a backslash-newline
# continuation into one logical line before parsing it, so this file
# assigns CODE_PATH_RE (split across the two physical lines below) the
# value '^rogue/' at runtime. A line-oriented text scan for the variable's
# name would never see it as a contiguous token on either physical line,
# silently missing this as a reference to the variable at all. Must be a
# hard error, not silently unseen.
CODE_PATH_\
RE='^rogue/'
