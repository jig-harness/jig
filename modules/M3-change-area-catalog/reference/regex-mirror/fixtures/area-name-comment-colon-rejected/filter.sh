#!/usr/bin/env bash
# "app # pretend colon:" has no real key: mapping colon — the only colon on
# the line sits inside a trailing comment, which Ruby Psych rejects outright
# (there's no actual mapping entry here, so the areas: block can't validly
# contain it). A naive colon search over the whole raw line, rather than only
# the portion before any genuine comment, would find that comment's colon
# and misread the line as declaring an area named "app # pretend colon".
# Must be a hard error, same as the colonless-area-line case.
CODE_PATH_RE='^apps/'
