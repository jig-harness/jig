#!/usr/bin/env bash
# Regresses a false-agreement bug: an unescaped $ or ^ embedded mid-string
# (not the leading/trailing anchor already stripped and handled) is a regex
# anchor, not a literal character — ^src/$generated/ would normalize to the
# literal-looking prefix "src/$generated" without this rejection, but the
# actual regex's mid-string $ matches nothing beyond that point. Must be a
# hard error.
CODE_PATH_RE='^src/$generated/'
