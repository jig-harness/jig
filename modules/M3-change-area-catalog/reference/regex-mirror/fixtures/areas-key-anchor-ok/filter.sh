#!/usr/bin/env bash
# A single YAML anchor after the areas: colon (areas: &catalog) tags
# the nested mapping itself, a common, idiomatic pattern — not a
# scalar value the trailing-content check should reject. Must stay
# supported, not become collateral damage from rejecting the
# unrelated areas: invalid (scalar-value) case.
CODE_PATH_RE='^apps/'
