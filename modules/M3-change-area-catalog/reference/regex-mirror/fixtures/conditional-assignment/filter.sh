#!/usr/bin/env bash
# Regresses a false-agreement bug: sourcing this file never actually
# assigns CODE_PATH_RE at all — the condition is always false, so the
# variable stays unset (or inherited from the environment, outside this
# file's control). A scan that recognizes the assignment line in isolation
# without noticing it's wrapped in a conditional would certify a value the
# real shortcut never uses. Must be a hard error: the conditional's own
# lines (if/fi) are neither blank, a comment, nor the one recognized
# assignment, so the whole file is unrecognized regardless of what's
# inside the conditional.
if false; then
  CODE_PATH_RE='^apps/'
fi
