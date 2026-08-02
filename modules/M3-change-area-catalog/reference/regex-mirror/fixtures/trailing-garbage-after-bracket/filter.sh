#!/usr/bin/env bash
# Regresses a validation gap: the scanner stopped at the array's closing ]
# without checking what follows it on the line. Trailing non-comment content
# after ] (here, a stray "garbage" token) is malformed YAML and must be a
# hard error, not silently ignored.
CODE_PATH_RE='^apps/'
