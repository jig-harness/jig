#!/usr/bin/env bash
# Regresses a silent-narrowing bug: an unquoted second array element
# (services/** with no surrounding quotes) violates the documented
# double-quoted-string-array schema. The old scanner would silently drop it
# and validate only against the one well-formed entry it happened to find;
# malformed input must hard-error instead.
CODE_PATH_RE='^apps/'
