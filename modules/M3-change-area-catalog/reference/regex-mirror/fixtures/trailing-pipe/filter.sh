#!/usr/bin/env bash
# Regresses a silent-skip bug: unquoted `for seg in $RE` word-splitting on
# IFS='|' drops a *trailing* empty field, so a regex ending in `|` — whose
# actual empty alternative matches every path — would check only the
# preceding alternative and pass.
CODE_PATH_RE='^apps/|'
