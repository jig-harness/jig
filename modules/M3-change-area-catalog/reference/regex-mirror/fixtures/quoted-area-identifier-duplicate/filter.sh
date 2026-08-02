#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog declares web-app
# twice — once quoted ("web-app":), once bare (web-app:) — both of which
# decode to the identical YAML key. A tracker that compares raw source
# text without stripping quotes would treat these as two different
# identifiers and never flag the duplicate, unioning both entries' globs.
# Must be a hard error, exactly like the unquoted-vs-unquoted case.
CODE_PATH_RE='^apps/'
