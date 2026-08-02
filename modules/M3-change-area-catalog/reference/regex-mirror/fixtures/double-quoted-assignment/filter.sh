#!/usr/bin/env bash
# Regresses a false-agreement bug: a double-quoted assignment does its own
# shell backslash processing at source time, so its raw source text is not
# the runtime value — CODE_PATH_RE="^dir\\file/" (two source backslashes)
# assigns the one-backslash string ^dir\file/ when actually sourced. This
# gate extracts raw source text without evaluating shell quoting, so
# applying its own backslash decoding to that raw text would double-decode
# it. Must be a hard error, not silently mis-decoded.
CODE_PATH_RE="^apps/"
