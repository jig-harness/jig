#!/usr/bin/env bash
# Regresses a fail-open bug: the paired catalog's paths: line sits
# directly under areas: at the paths-field indentation, but with no
# 2-space area-name line ever declaring an area to hang it off of. A
# handler that parses any 4-space paths: line inside the areas: block
# regardless of whether an area is currently open would still harvest
# apps/** and let ^apps/ falsely pass, even though no real area
# declares that glob. Must be a hard error, not silently accepted.
CODE_PATH_RE='^apps/'
