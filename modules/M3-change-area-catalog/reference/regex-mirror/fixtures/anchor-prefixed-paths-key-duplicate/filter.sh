#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog's web-app area
# declares paths: twice — once bare, once prefixed with a YAML anchor
# (&dup paths:) that a real loader resolves to the same paths key
# regardless of the anchor. A scanner that doesn't recognize the
# anchor-prefixed spelling as a paths: declaration at all would
# simply skip the line as unrecognized content, leaving the first
# (soon-to-be-discarded, per most-lenient-parser duplicate-key
# semantics) declaration as the only one seen — the same hazard
# already closed for the root areas: key, one level deeper. Must be a
# hard error.
CODE_PATH_RE='^apps/'
