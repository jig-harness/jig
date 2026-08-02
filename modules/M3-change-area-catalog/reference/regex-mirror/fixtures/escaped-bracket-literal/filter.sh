#!/usr/bin/env bash
# Regresses a false-agreement bug: the catalog glob apps/[ab]/** is a
# bracket character class matching a or b (apps/a/**, apps/b/**) — its
# literal head is apps/, not apps/[ab]/. An escaped-literal alternative that
# matches the bracket text verbatim (^apps/\[ab\]/, i.e. a directory
# literally named "[ab]") matches neither apps/a/... nor apps/b/..., so
# comparing it against the raw catalog text as if [ab] were literal would
# falsely certify coverage of a glob this regex can't actually match.
CODE_PATH_RE='^apps/\[ab\]/'
