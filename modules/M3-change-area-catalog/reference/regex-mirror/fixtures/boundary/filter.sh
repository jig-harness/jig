#!/usr/bin/env bash
# Regresses a path-component-boundary bug: normalized prefix "services" must
# not falsely match sibling directory "services-old/**".
CODE_PATH_RE='^apps/|^services/'
