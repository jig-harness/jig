#!/usr/bin/env bash
# Regresses a false-agreement bug: a directory-form alternative
# (^package\.json/) requires an actual / after the prefix at runtime, so it
# can never match the bare literal file package.json. Comparing "rest == ''"
# as a match regardless of alternative kind would let this pass against a
# catalog that declares only the exact, wildcard-free path package.json —
# with no descendant tree for the trailing / to land in.
CODE_PATH_RE='^package\.json/'
