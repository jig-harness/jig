#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog's second
# top-level areas key uses a YAML Unicode escape ("areas":) that a
# real loader decodes to the identical areas key the first bare
# areas: line declares. A recognizer matching only the literal,
# unescaped "areas": spelling doesn't see this line as that key at
# all — it isn't parsed as a duplicate, it's simply invisible, and the
# scanner falls through to whatever generic handling applies to an
# unrecognized column-zero line. This gate doesn't implement Unicode
# escape decoding (see the paths: array parser's own \" / \\ -only
# policy), so it must reject the escape outright rather than silently
# treating the escaped line as something else.
CODE_PATH_RE='^apps/'
