#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog declares the
# top-level areas: key twice, with different area identifiers under each.
# A real YAML parser sees one duplicate top-level mapping key and
# commonly retains only one (often the last, other-area's rogue/**), not
# both. A scanner that re-enters the block on the second areas: line and
# keeps accumulating from both mappings would let ^apps/ pass even though
# the resolver can never see it. Must be a hard error.
CODE_PATH_RE='^apps/'
