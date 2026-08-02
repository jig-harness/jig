#!/usr/bin/env bash
# Regresses a fail-open bug: an empty array (paths: []) violates the
# schema's >=1-path requirement and must be a hard error for the whole run,
# even though a second, unrelated area declares a valid path.
CODE_PATH_RE='^apps/'
