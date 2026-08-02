#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog has a genuinely
# unrelated metadata: section between the first areas: mapping and an
# anchor-prefixed duplicate (&dup areas:). The unrelated metadata:
# key legitimately clears the scanner's in_areas flag, but a check
# gated on that transient flag (rather than the permanent fact that
# areas: has been seen at all) would stop watching for a
# property-prefixed duplicate root key once metadata: appears,
# letting &dup areas: slip through even though a real YAML loader
# still resolves it to the same areas key and retains its rogue/**
# mapping instead. Must be a hard error regardless of what came
# between the two occurrences.
CODE_PATH_RE='^apps/'
