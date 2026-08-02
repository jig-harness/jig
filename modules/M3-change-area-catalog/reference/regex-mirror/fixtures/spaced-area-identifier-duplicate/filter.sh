#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog declares web-app
# twice — once quoted with separation whitespace before the colon
# ("web-app" :), once bare (web-app:) — both of which decode to the
# identical YAML key. Extracting the raw text up to the first colon
# without trimming that trailing whitespace would leave a dangling
# space inside the quote-detection check, so the quotes are never
# stripped and the duplicate slips through unioned instead of
# rejected. Must be a hard error, exactly like the tight-colon case.
CODE_PATH_RE='^apps/'
