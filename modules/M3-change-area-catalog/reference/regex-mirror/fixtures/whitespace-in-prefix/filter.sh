#!/usr/bin/env bash
# Regresses a false-agreement bug: a literal trailing space before the
# final / is part of the path the runtime regex matches ("apps/dir /...",
# not "apps/dir/..."). Trimming it would silently normalize to a prefix
# the regex doesn't actually produce, passing against an unrelated catalog
# glob like apps/dir/**. Must be a hard error, not silently trimmed.
CODE_PATH_RE='^apps/dir /'
