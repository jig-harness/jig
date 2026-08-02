#!/usr/bin/env bash
# Regresses a false-agreement bug: without a leading ^, this alternative can
# match a path anywhere the literal "apps/" occurs, not just at its start
# (e.g. "docs/apps/file"), even though it normalizes to a prefix that looks
# identical to the anchored ^apps/ form. Must be a hard error.
CODE_PATH_RE='apps/'
