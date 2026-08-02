#!/usr/bin/env bash
# "--- junk" carries the marker's trailing text as real scalar content, not
# a bare document-start decoration — a real loader (verified: both PyYAML
# and Psych) rejects the whole document once it reaches the areas: mapping
# afterward, since a scalar document has no room for one. Treating any
# post-marker text as skippable, the same as a bare --- or --- # comment,
# would accept a catalog the resolver can't load. Must be a hard error.
CODE_PATH_RE='^apps/'
