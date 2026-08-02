#!/usr/bin/env bash
# Regresses a grammar-permissiveness bug: two commas in a row
# (["apps/**",, "services/**"]) is not valid YAML and must be a hard error,
# not silently tolerated as an empty middle element.
CODE_PATH_RE='^apps/'
