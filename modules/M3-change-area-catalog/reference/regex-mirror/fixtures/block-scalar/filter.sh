#!/usr/bin/env bash
# Regresses a false-pickup bug: a notes: block scalar's indented prose that
# happens to look like a paths: line must not count as an area declaring
# that path.
CODE_PATH_RE='^apps/|^services/'
