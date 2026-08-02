#!/usr/bin/env bash
# Regresses a false-agreement bug: the catalog glob apps/@(web)/** uses a
# bash/ksh extglob group, a variable construct exactly like *, [ab], ?, or
# {web,api} — it matches apps/web/**, not a directory literally named
# "@(web)". This implementation's literal-head scan only recognizes
# *, [, ?, and { as variable-construct prefixes, not @/!/+ before a (, so
# without an explicit reject it would treat apps/@(web)/ as the whole
# literal head and let an escaped-literal alternative like
# ^apps/@\(web\)/ falsely certify coverage it doesn't have. Must be a hard
# error, not a silent false pass.
CODE_PATH_RE='^apps/@\(web\)/'
