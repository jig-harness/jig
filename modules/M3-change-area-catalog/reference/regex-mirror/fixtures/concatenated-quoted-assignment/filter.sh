#!/usr/bin/env bash
# Regresses a false-agreement bug: two adjacent single-quoted shell words
# concatenate at parse time, so CODE_PATH_RE='^apps/''quoted/' assigns the
# one-word runtime value ^apps/quoted/. This gate's raw-text extraction has
# no interior-quote handling, so it would instead read ^apps/''quoted/ (the
# closing/opening quote pair from the boundary still embedded) and could
# certify a prefix the real regex doesn't have. Must be a hard error, not
# silently mis-extracted.
CODE_PATH_RE='^apps/''quoted/'
