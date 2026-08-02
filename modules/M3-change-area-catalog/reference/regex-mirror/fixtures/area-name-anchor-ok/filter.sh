#!/usr/bin/env bash
# A single YAML anchor after an area name's colon (web-app: &defaults)
# tags the nested mapping itself, mirroring the same idiomatic pattern
# as the areas: root key. Must stay supported, not become collateral
# damage from rejecting the unrelated web-app: invalid (scalar-value)
# case.
CODE_PATH_RE='^apps/'
