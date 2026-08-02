#!/usr/bin/env bash
# Regresses a false-agreement bug: the paired catalog declares web-app
# twice — once with a YAML Unicode escape spelling out the hyphen
# ("web-app":), once bare (web-app:) — both of which a real YAML
# loader decodes to the identical web-app key. A tracker that only
# strips the surrounding quotes without decoding escapes inside would
# treat "web-app" as a distinct, undecoded key and never flag the
# duplicate, unioning both entries' globs. This gate doesn't implement
# Unicode escape decoding (see the paths: array parser's own \" / \\
# -only policy), so it must reject the escape outright rather than
# silently comparing raw, undecoded text.
CODE_PATH_RE='^apps/'
