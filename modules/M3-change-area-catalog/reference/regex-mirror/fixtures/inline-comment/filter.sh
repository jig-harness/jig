#!/usr/bin/env bash
# Regresses an inline-comment bug: a trailing `# comment` after a paths:
# array must not leak into the parsed glob value.
CODE_PATH_RE='^package\.json$'
