#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog's second
# top-level areas key is prefixed with a YAML anchor (&dup areas:) —
# a node property a real YAML loader (e.g. Psych) resolves to the
# same areas root key regardless of the anchor, retaining only the
# later mapping. A scanner that doesn't recognize the anchor-prefixed
# spelling as this gate's areas: key falls through to whatever
# handling applies to an unrecognized column-zero line and silently
# treats it as ending the block, letting the duplicate slip past
# entirely undetected instead of rejected. Must be a hard error.
CODE_PATH_RE='^apps/'
