#!/usr/bin/env bash
# The real areas: mapping sits in a second YAML document, after a ...
# document-end marker, behind an unrelated first document. Same class of
# gap as the --- separator case: Ruby's Psych.safe_load silently keeps only
# the first document regardless of which marker ends it (verified directly
# — the areas: block is dropped entirely, no error), while PyYAML's
# safe_load raises outright on multi-document input. Must be a hard error.
CODE_PATH_RE='^apps/'
