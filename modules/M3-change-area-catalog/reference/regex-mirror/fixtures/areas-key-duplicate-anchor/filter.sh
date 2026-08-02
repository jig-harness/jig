#!/usr/bin/env bash
# A YAML node can carry at most one anchor — &catalog &second after the
# areas: colon is not two independent properties the way an anchor and
# a tag are, it's a malformed node no real YAML loader accepts. Now
# that the gate tolerates an anchor and a tag together, it must still
# reject a second token of the *same* kind rather than treating any
# two-token combination as the supported anchor-plus-tag form.
CODE_PATH_RE='^apps/'
