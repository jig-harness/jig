#!/usr/bin/env bash
# The gate set, runnable with one command (M1 Lite, dogfooded).
# Order: self-tests first (a broken gate must not "pass"), then the gates.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")

"$here/test-gates.sh"
"$here/check-md-links.sh" "$root"
"$here/check-md-tables.sh" "$root"
"$here/check-glossary-coverage.sh" "$root"
echo "all gates passed"
