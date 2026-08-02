#!/usr/bin/env bash
# areas: !tag<x> is not valid YAML: an angle bracket breaks tag scanning in
# both libyaml and Psych, along with a quote, hash, percent, backslash,
# caret, backtick, brace, or pipe — a narrower exclusion set than an
# anchor's, but not "anything non-whitespace." A scanner that accepts any
# whitespace-free tag payload would exit 0 for a catalog the resolver
# can't load. Must be a hard error.
CODE_PATH_RE='^apps/'
