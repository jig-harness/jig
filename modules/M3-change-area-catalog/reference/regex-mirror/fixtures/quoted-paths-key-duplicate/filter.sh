#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog's web-app area
# declares paths: twice — once bare (paths:), once double-quoted
# ("paths":) — both of which decode to the identical YAML key. A
# recognizer matching only the bare spelling would miss the quoted line
# as a duplicate and instead parse it as a second, independent paths:
# declaration, unioning both entries' globs. Must be a hard error,
# exactly like the bare-vs-bare duplicate case.
CODE_PATH_RE='^apps/'
