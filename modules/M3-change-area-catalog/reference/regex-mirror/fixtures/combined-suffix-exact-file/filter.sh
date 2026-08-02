#!/usr/bin/env bash
# Regresses a false-agreement bug: ^package\.json/$ requires a trailing
# slash the exact catalog file "package.json" never has, so the runtime
# regex can never match it — but stripping the $ then the / in sequence
# would normalize this to the same prefix "package.json" as a clean exact
# match and falsely pass against that catalog value. Must be a hard error.
CODE_PATH_RE='^package\.json/$'
