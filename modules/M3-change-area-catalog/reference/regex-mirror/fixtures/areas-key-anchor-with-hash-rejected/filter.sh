#!/usr/bin/env bash
# &catalog#v1 is not valid YAML: real loaders (libyaml, Psych) restrict an
# anchor name to alphanumerics and a few punctuation characters and reject
# a `#` inside it even with no preceding whitespace, despite the formal
# grammar's broader "any non-flow-indicator, non-whitespace character"
# wording suggesting otherwise. A scanner that skips past a non-whitespace-
# preceded `#` looking for a later, genuine comment start would accept this
# catalog and exit 0 for a file the real resolver can't even load. Must be
# a hard error.
CODE_PATH_RE='^apps/'
