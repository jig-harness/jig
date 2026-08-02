#!/usr/bin/env bash
# Regresses a false-agreement bug: a quoted string inside a trailing inline
# comment (`# formerly "services/**"`) must not be harvested as though it
# were a declared paths: entry. No area declares services/, so this
# alternative must be reported as drift.
CODE_PATH_RE='^services/'
