#!/usr/bin/env bash
# Regresses a fail-open bug: the paired catalog's web-app line at the
# 2-space area-name indentation has no colon at all, so it isn't a
# valid key: mapping entry — not something a real YAML parser would
# accept as declaring an area. A recognizer that only checks for
# 2-space indentation and a non-comment character, without requiring
# an actual colon, would still treat it as a normal area name and
# harvest the indented paths: below it. Must be a hard error.
CODE_PATH_RE='^apps/'
