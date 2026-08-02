#!/usr/bin/env bash
# areas: !!str is character-valid (an ordinary !!-prefixed tag token) but
# semantically broken: !!str is YAML's core-schema scalar-string tag, and
# a real loader can't construct it against the indented nested mapping that
# follows (PyYAML: "expected a scalar node, but found mapping"; Psych errors
# too). A scanner validating only tag characters, not node-kind
# compatibility, would accept this and exit 0 for a catalog the resolver
# can't load. Only !!map is allowed among !!-prefixed core tags at this
# position; every other one is a hard error.
CODE_PATH_RE='^apps/'
