#!/usr/bin/env bash
# ^dir\\$ ends in an escaped backslash (\\, one literal \ character)
# immediately followed by a genuinely unescaped $ anchor — the runtime
# regex matches exactly the literal path "dir\". Checking only "does the
# alternative end in the two-char sequence \$" would wrongly classify this
# $ as escaped (looking only at the very last two characters); it must
# instead count the run of backslashes before the $ and see that it's
# even (one pair), so the $ is real.
CODE_PATH_RE='^dir\\$'
