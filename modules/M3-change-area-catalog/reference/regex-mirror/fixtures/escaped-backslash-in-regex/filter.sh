#!/usr/bin/env bash
# Regresses a false-drift bug: an escaped backslash (\\) in a regex
# alternative represents one literal backslash character in the matched
# string — ^dir\\file/ matches "dir\file/..." at runtime, the same string
# the catalog's dir\file/** (one backslash, decoded from its own YAML
# escape) declares. A blanket "delete every backslash" normalization would
# instead strip both backslash characters independently, producing "dirfile"
# and reporting drift against a catalog that actually does declare this path.
CODE_PATH_RE='^dir\\file/'
