#!/usr/bin/env bash
# Regresses a false-agreement bug: with no trailing $, /, /**, or /.*, this
# alternative's end is unbounded and can also match an undeclared sibling
# path like apps-old/main.ts, even though it normalizes to a prefix that
# looks identical to a properly-bounded ^apps/ form. Must be a hard error.
CODE_PATH_RE='^apps'
