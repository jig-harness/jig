#!/usr/bin/env bash
# Regresses a mis-decode/silent-accept bug: the scanner isn't a real YAML
# escape decoder. A valid YAML Unicode escape (f, denoting the literal
# character "f") would previously be copied verbatim as "u0066" instead of
# decoded, and an invalid escape would be silently accepted as whatever
# character follows the backslash. Only \" and \\ are supported; anything
# else must be a hard error, not a silent mis-parse.
CODE_PATH_RE='^apps/foo/'
