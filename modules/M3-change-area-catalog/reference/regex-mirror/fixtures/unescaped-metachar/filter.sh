#!/usr/bin/env bash
# Regresses a false-agreement bug: an unescaped regex metacharacter (`.` here)
# normalizes to a plain-looking literal ("apps.web") and would be compared as
# such, but the actual regex's `.` also matches e.g. `appsXweb/`, a path the
# catalog never declares under that prefix. Must be a hard error, not silently
# treated as a literal path.
CODE_PATH_RE='^apps.web/'
