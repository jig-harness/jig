#!/usr/bin/env bash
# Regresses a false-agreement bug: the catalog glob apps/web-?/** uses ?, a
# standard single-character glob wildcard, matching apps/web-a/**,
# apps/web-b/**, etc. — its literal head is apps/, not apps/web-?/. An
# escaped-literal alternative matching the ? text verbatim (^apps/web-\?/,
# i.e. a directory literally named "web-?") matches none of those paths, so
# treating ? as ordinary literal text in the catalog glob would falsely
# certify coverage of paths this regex can't actually match.
CODE_PATH_RE='^apps/web-\?/'
