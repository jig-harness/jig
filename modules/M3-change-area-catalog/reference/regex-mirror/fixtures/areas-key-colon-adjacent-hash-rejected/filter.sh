#!/usr/bin/env bash
# areas:#note is not valid YAML: a # must be preceded by whitespace (or be
# at start of line) to be recognized as a comment, so a colon immediately
# followed by # forms no valid mapping separator at all — a real loader
# rejects this outright. A scanner that treats any # right after the colon
# as "just a trailing comment, the mapping still opens normally" would
# accept a catalog the resolver can't load. Must be a hard error.
CODE_PATH_RE='^apps/'
