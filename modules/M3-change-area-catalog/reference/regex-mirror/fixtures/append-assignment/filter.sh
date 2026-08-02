#!/usr/bin/env bash
# Regresses a false-agreement bug: sourcing this file leaves CODE_PATH_RE
# as '^apps/|^rogue/', not '^apps/' — the += append is a real mutation a
# fixed-shape scan for the plain RE_VAR= assignment form alone would never
# even recognize as touching the variable, silently validating only the
# harmless first alternative while the live regex also matches the
# undeclared 'rogue' prefix. Must be a hard error: this gate requires the
# variable's name to appear nowhere except its own single assignment line.
CODE_PATH_RE='^apps/'
CODE_PATH_RE+='|^rogue/'
