#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog's services/** glob
# sits under metadata.unrelated, not under areas: — it does not declare a
# real area's membership. A scanner that recognizes any 4-space-indented
# paths: line regardless of which top-level section it's under would
# harvest it anyway, letting ^services/ falsely pass as covered. Must
# report drift (no real area declares this prefix), not silently pass.
CODE_PATH_RE='^services/'
