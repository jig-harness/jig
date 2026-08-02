#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog's web-app area
# declares paths: twice — once bare (paths:), once with a YAML
# Unicode escape ("paths":) that a real loader decodes to the
# identical paths key. A recognizer matching only the literal,
# unescaped "paths": spelling doesn't see the escaped line as a
# paths: declaration at all, so it's invisible rather than flagged as
# a duplicate — the gate would certify apps/** using only the first,
# unescaped declaration, even though a YAML loader retains the
# escaped line's rogue/** instead. This gate doesn't implement
# Unicode escape decoding (see the paths: array parser's own \" / \\
# -only policy), so it must reject the escape outright.
CODE_PATH_RE='^apps/'
