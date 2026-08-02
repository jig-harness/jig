#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog's second top-level
# areas key has separation whitespace before the colon (areas :), which
# valid YAML permits and still decodes to the same root key as the first
# bare areas:. A recognizer requiring the colon to immediately follow
# the key name would miss this line as a duplicate and instead treat it
# as ending the scan, silently validating only the harmless first
# mapping. Must be a hard error, exactly like the tight-colon case.
CODE_PATH_RE='^apps/'
