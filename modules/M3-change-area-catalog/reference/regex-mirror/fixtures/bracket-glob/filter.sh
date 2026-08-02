#!/usr/bin/env bash
# Regresses a mis-parse bug: a catalog glob containing its own `]`
# (`"apps/[ab]/**"`) would truncate a naive first-`]`-wins array scan before
# the closing quote, dropping the path (and, if it's the only one, hard-
# erroring with "no area paths"). A quote-aware scan must capture it whole.
CODE_PATH_RE='^apps/'
