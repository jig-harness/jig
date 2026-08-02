#!/usr/bin/env bash
# Regresses a false-pickup bug: a reserved block's own nested paths: key
# (indented one level deeper than an area's own fields) must not count as an
# area declaring that path.
CODE_PATH_RE='^apps/|^services/'
