#!/usr/bin/env bash
# Regresses a false-agreement bug: ^apps/$ matches only the literal string
# "apps/" (with a trailing slash) — a different string from the bare "apps"
# that ^apps$ matches. Stripping both the $ and the / in sequence collapses
# it to the same normalized prefix "apps" as a clean exact match, but the
# two runtime regexes match different things. Must be a hard error.
CODE_PATH_RE='^apps/$'
