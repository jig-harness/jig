#!/usr/bin/env bash
# areas: !unknown is character-valid, and whether it actually resolves
# depends entirely on the consumer's own registered tag schema — adopter-
# specific policy this vendor-agnostic reference script has no way to know.
# Loader-default behavior toward an unregistered tag isn't a property of
# the catalog file itself: a correctly-configured adopter may have this
# exact tag registered. Custom-tag character validity is checked like any
# tag's; whether it resolves is out of scope, so this must stay a pass.
CODE_PATH_RE='^apps/'
