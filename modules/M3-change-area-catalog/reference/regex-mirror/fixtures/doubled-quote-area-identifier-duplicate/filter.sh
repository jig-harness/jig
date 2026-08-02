#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog declares the
# same area identifier twice — once as a plain (unquoted) scalar
# containing a literal single quote (web'app:), once single-quoted
# with YAML's doubled-quote escape ('web''app':) — both of which
# decode to the identical YAML key web'app. A naive outer-shape check
# like `area_name ~ /^'[^']*'$/` can't see past the doubled quote
# (the character class disallows any literal ' at all, doubled or
# not), so it never even recognizes the second line as quoted, let
# alone decodes and compares it — the duplicate is invisible, not
# just unflagged. Mirrors the escaped-quote-area-identifier-duplicate
# fixture, one quote style over. Must be a hard error.
CODE_PATH_RE='^apps/'
