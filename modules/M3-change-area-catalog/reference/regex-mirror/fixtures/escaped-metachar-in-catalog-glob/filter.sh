#!/usr/bin/env bash
# Regresses a false-agreement bug: the catalog glob apps/literal\[name\]/**
# uses a backslash-escaped bracket — a literal `[` character, per the same
# escaping convention this gate already supports on the regex side (e.g.
# ^apps/\[ab\]/ is a genuine literal there) — not a variable bracket class.
# Without escape-awareness, the literal-head scan would treat that `[` as
# an unescaped trigger and truncate the head at the preceding /, to just
# apps/, losing literal-vs-variable information the catalog side actually
# has. This alternative's decoded prefix, apps/literal[name], must match
# the catalog's decoded literal head exactly (at the boundary right after
# the closing bracket), not merely as a shorter ancestor prefix.
CODE_PATH_RE='^apps/literal\[name\]/'
