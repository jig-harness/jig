#!/usr/bin/env bash
# A trailing ... with nothing after it is an ordinary, optional
# single-document terminator — this catalog is still exactly one document,
# loading identically with or without it. Rejecting any ... unconditionally
# would fail valid, idiomatic YAML that never actually has a second
# document.
CODE_PATH_RE='^apps/'
