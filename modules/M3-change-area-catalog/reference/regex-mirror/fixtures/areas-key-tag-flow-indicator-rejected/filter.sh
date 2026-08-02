#!/usr/bin/env bash
# areas: !tag,v1 is not valid YAML: a flow indicator (, [ ]) breaks tag
# scanning in libyaml just as it does in an anchor name (verified against
# the C-accelerated loader both Ruby's Psych and a properly configured
# PyYAML installation wrap) — libyaml rejects this with "did not find
# expected whitespace or line break while scanning a tag". Must be a hard
# error.
CODE_PATH_RE='^apps/'
