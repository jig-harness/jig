#!/usr/bin/env bash
# areas: &catalog, is not valid YAML: a flow indicator (, [ ] { }) cannot
# appear in an anchor name even outside flow context — both libyaml and
# Psych reject it. An anchor name is alphanumerics, -, and _ only, a much
# narrower set than "any non-whitespace character after &". A scanner that
# only checks for the & prefix and absence of whitespace would accept this
# and exit 0 for a catalog the resolver can't load. Must be a hard error.
CODE_PATH_RE='^apps/'
