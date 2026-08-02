#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog declares the
# top-level areas key first using YAML's explicit-key form (`? areas`
# followed by `:` and a mapping), then declares it again as a plain
# areas: key. Both spellings decode to the same root key to a real
# YAML loader, which keeps only the later mapping — but a scanner
# recognizing only the plain `key:` form doesn't see `? areas` as this
# gate's areas: key at all, so it falls through to whatever handling
# applies to an unrecognized column-zero line and then treats the
# later plain areas: as the sole declaration instead of flagging the
# duplicate. Must be a hard error regardless of which spelling comes
# first.
CODE_PATH_RE='^apps/'
