#!/usr/bin/env bash
# A directory-form alternative whose prefix is a genuine strict ancestor of
# an exact wildcard-free catalog path (^apps/ is a real ancestor directory of
# apps/config.json, and the runtime regex does match that file) must stay
# supported — the exact-file restriction only excludes the case where the
# alternative's prefix would equal the *entire* exact path, not a real
# ancestor relationship.
CODE_PATH_RE='^apps/'
