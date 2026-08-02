#!/usr/bin/env bash
# A real YAML node can carry an anchor and a tag together, not just one
# or the other (areas: &catalog !!map) — a scanner that only tolerates
# a single node-property token after the colon would reject this
# structurally valid mapping as though it had a disallowed scalar
# value, even though it opens the same nested areas: mapping the gate
# already supports for a lone anchor or lone tag.
CODE_PATH_RE='^apps/'
