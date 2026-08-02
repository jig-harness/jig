#!/usr/bin/env bash
# A backslash-escaped metacharacter is a literal, not a regex construct, and
# must stay supported: the catalog's path genuinely contains a literal dot.
CODE_PATH_RE='^apps\.web/'
