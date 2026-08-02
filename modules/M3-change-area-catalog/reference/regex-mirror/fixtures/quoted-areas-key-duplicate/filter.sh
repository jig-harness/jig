#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog declares the
# top-level areas key twice — once bare (areas:), once double-quoted
# ("areas":) — both of which decode to the identical YAML key. A scanner
# that only recognizes the unquoted spelling would re-enter the block on
# the quoted line instead of rejecting it as a duplicate, letting ^apps/
# pass even though a real YAML loader (Psych et al.) retains only the
# later mapping and the resolver never sees apps/**. Must be a hard
# error, exactly like the unquoted-vs-unquoted case.
CODE_PATH_RE='^apps/'
