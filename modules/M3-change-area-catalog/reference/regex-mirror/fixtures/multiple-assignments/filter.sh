#!/usr/bin/env bash
# Regresses a false-agreement bug: sourcing this file leaves only the
# second, rogue assignment active at runtime — CODE_PATH_RE ends up
# '^rogue/', not '^apps/'. A gate that validated only the first assignment
# (or silently picked one without checking there was just one) would check
# a harmless value the real shortcut never actually uses. Must be a hard
# error, not silently resolved to either assignment.
CODE_PATH_RE='^apps/'
CODE_PATH_RE='^rogue/'
