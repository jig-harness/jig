#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog declares the
# same area identifier twice — once as a plain (unquoted) scalar
# containing a literal double quote (web"app:), once double-quoted
# with the supported \" escape ("web\"app":) — both of which decode
# to the identical YAML key web"app. A naive outer-shape check like
# `area_name ~ /^"[^"]*"$/` can't see past the escaped quote (the
# character class disallows any literal " at all, escaped or not), so
# it never even recognizes the second line as quoted, let alone
# decodes and compares it — the duplicate is invisible, not just
# unflagged. Must be a hard error, exactly like the other quoted
# duplicate-identifier fixtures.
CODE_PATH_RE='^apps/'
