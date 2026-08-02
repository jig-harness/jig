#!/usr/bin/env bash
# The real areas: mapping sits in a second YAML document, after a ---
# separator, behind an unrelated first document. A single-document loader
# never sees it the way a scanner would if it just kept reading past the
# separator: Ruby's Psych.safe_load silently keeps only the first document
# (verified directly — the areas: block is dropped entirely, no error),
# while PyYAML's safe_load raises outright on multi-document input. Either
# way, scanning past --- and certifying coverage from the second document
# risks agreeing with a catalog state the real resolver never sees, or
# can't load at all. Must be a hard error.
CODE_PATH_RE='^apps/'
