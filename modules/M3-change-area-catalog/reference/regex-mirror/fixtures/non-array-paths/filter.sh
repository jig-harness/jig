#!/usr/bin/env bash
# Regresses a silent-skip bug: a paths: line that isn't the supported inline
# array form (paths: "apps/**", a bare string) was matched by no pattern at
# all and silently ignored, even though a second, unrelated area's
# well-formed array kept PATH_GLOBS non-empty and let the gate pass having
# never validated the malformed declaration.
CODE_PATH_RE='^apps/'
