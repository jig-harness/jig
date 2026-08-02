#!/usr/bin/env bash
# Regresses a false-agreement bug: many glob dialects (gitignore-style
# negation, micromatch/minimatch's negate option) treat a leading ! as
# "exclude paths matching the rest of this pattern," not a literal
# character — !apps/** means "not apps/**," the opposite of a directory
# literally named "!apps". Literal-head reduction has no concept of
# exclusion, so treating it as an ordinary literal would let
# ^!apps/ falsely certify coverage of what the resolver actually excludes.
# Must be a hard error, not a silent false pass.
CODE_PATH_RE='^!apps/'
