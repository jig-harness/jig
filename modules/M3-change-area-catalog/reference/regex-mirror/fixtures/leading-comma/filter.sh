#!/usr/bin/env bash
# Regresses a grammar-permissiveness bug: a comma before the first string
# (paths: [,"apps/**"]) is not valid YAML and must be a hard error, not
# silently tolerated as an empty leading element.
CODE_PATH_RE='^apps/'
