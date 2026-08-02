#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog's web-app area has
# no paths: field at all — a schema violation the scanner never
# recognized as one, since it only checked for a *second* paths: key
# within an area, never the absence of a first. The run would still exit
# 0 here because core-lib's own glob happens to cover ^packages/, masking
# the missing-required-field error. Must be a hard error regardless of
# what other areas declare.
CODE_PATH_RE='^packages/'
