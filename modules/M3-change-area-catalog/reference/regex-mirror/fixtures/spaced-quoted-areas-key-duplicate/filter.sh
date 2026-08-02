#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog's second top-level
# areas key is both quoted and has separation whitespace before the
# colon ("areas" :), which valid YAML permits and still decodes to the
# same root key as the first bare areas:. A recognizer that only
# accepts a quoted key with the colon immediately following the closing
# quote would miss this line as a duplicate. Must be a hard error,
# exactly like the tight-colon quoted case.
CODE_PATH_RE='^apps/'
