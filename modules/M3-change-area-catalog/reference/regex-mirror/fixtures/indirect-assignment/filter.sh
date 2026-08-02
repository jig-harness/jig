#!/usr/bin/env bash
# Regresses a false-agreement bug: bash concatenates adjacent quoted and
# unquoted segments before evaluating a command's arguments, so
# printf -v CODE_PATH_''RE ... assigns CODE_PATH_RE (built from
# "CODE_PATH_" + "" + "RE", never appearing as one contiguous source
# token) the second, unchecked value. A scan that only recognizes a plain
# RE_VAR= assignment line, and only checks contiguous occurrences of the
# variable's name, would see just the first, harmless assignment. Must be
# a hard error: any second non-blank, non-comment line makes the whole
# file unrecognized, whatever that line contains.
CODE_PATH_RE='^apps/'
printf -v CODE_PATH_''RE %s '^apps/|^rogue/'
