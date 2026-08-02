#!/usr/bin/env bash
# Regresses a truncation bug: the paths: scanner toggled quote state on every
# " without checking for a YAML backslash escape, so a glob containing an
# escaped quote (apps/foo\"bar/**, i.e. the literal string apps/foo"bar/**)
# was truncated right after the backslash, losing everything from "bar"
# onward. This alternative's prefix only matches the catalog value's full,
# correctly-unescaped text.
CODE_PATH_RE='^apps/foo"bar/'
