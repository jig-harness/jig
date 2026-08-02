#!/usr/bin/env bash
# A single trailing comma before the closing ] (["apps/**",]) is valid YAML
# and must stay supported, confirming the stricter grammar isn't over-tight.
CODE_PATH_RE='^apps/'
