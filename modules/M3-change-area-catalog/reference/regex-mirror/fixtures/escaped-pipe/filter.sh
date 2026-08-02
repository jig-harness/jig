#!/usr/bin/env bash
# Regresses a mis-split bug: the raw IFS='|' split is not escape-aware, so a
# backslash-escaped literal pipe meant as one alternative would be silently
# torn into two ('^apps\' and 'legacy/'). Must be a hard error, not a
# silent mis-parse.
CODE_PATH_RE='^apps\|legacy/'
