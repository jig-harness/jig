#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog's anchor-prefixed
# areas key (&dup areas:) comes first, and the plain areas: mapping
# follows. A real YAML loader (e.g. Psych) resolves both spellings to
# the same root key regardless of order and keeps only the later
# mapping — but a scanner that only starts watching for the
# property-prefixed spelling once it has already seen a plain areas:
# key never recognizes the first occurrence as that key at all, falls
# through to whatever handling applies to an unrecognized column-zero
# line, and then treats the later plain areas: as though it were the
# only declaration, silently accepting the pair instead of rejecting
# the duplicate. Must be a hard error regardless of which spelling
# comes first.
CODE_PATH_RE='^apps/'
