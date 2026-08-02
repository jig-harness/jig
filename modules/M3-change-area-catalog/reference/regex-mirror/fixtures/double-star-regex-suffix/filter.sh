#!/usr/bin/env bash
# Regresses a false-agreement bug: /** is well-defined glob syntax for a
# catalog value, but as an actual regex it is / followed by two adjacent *
# quantifiers — duplicate-quantifier behavior POSIX leaves engine-dependent,
# and permissive engines (e.g. Bash's [[ =~ ]]) commonly collapse it to
# "zero or more /", which lets ^apps/** match an undeclared sibling like
# apps-old with zero slashes and nothing after. Must be a hard error; use
# /.* instead, whose semantics are unambiguous.
CODE_PATH_RE='^apps/**'
