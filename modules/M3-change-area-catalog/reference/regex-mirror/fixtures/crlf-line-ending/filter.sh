#!/usr/bin/env bash
# Regresses a false-agreement bug: this file uses CRLF line endings, so
# the assignment line ends in an ordinary \r character before the real
# \n line terminator. Bash sourcing a single-quoted assignment does not
# strip that \r -- it becomes part of the runtime value, ^apps/\r -- but
# text tools that treat \r as generic whitespace could silently drop it
# during extraction, certifying a clean ^apps/ that is not the real
# runtime value. Must be a hard error, not silently normalized away.
CODE_PATH_RE='^apps/'
