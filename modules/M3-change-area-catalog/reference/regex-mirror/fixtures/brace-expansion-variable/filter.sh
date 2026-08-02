#!/usr/bin/env bash
# Regresses a false-agreement bug: the catalog glob apps/{web,api}/** uses a
# brace-expansion group, a variable construct exactly like *, [ab], or ? —
# it matches apps/web/** and apps/api/**, neither of which is a directory
# literally named "{web,api}". Its literal head is apps/, not
# apps/{web,api}/. An escaped-literal alternative matching the brace text
# verbatim (^apps/\{web,api\}/) matches neither real path, so treating {
# as ordinary literal text in the catalog glob would falsely certify
# coverage this regex can't actually provide.
CODE_PATH_RE='^apps/\{web,api\}/'
