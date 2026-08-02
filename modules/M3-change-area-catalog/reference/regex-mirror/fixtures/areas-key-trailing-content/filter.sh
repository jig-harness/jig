#!/usr/bin/env bash
# Regresses a fail-open bug: the paired catalog's areas: line has a
# trailing scalar value (areas: invalid) instead of opening a nested
# mapping. A recognizer matching only the key and colon, ignoring what
# follows, would still treat the indented lines below as though they
# were genuinely nested under areas: — but a real YAML parser reads
# areas as a scalar string, not a mapping, making everything below it
# invalid or a different construct entirely. Must be a hard error, not
# silently accepted as a normal areas: block.
CODE_PATH_RE='^apps/'
