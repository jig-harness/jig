#!/usr/bin/env bash
# Self-tests for the repo gates — M1 dogfooded: a gate without a self-test
# can silently stop catching anything. Each case runs a gate against a small
# fixture tree and asserts the expected pass/fail. Cases cd into the fixture
# so the gates' own `*/fixtures/*` path exclusion doesn't skip the inputs.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
fx="$here/tests/fixtures"
bad=0

run_case() {  # run_case <pass|fail> <fixture-dir> <cmd...>
  local want=$1 dir=$2; shift 2
  local got=0
  (cd "$fx/$dir" && "$@" >/dev/null 2>&1) || got=$?
  if { [ "$want" = pass ] && [ "$got" -eq 0 ]; } ||
     { [ "$want" = fail ] && [ "$got" -ne 0 ]; }; then
    echo "ok: $dir ($(basename "$1"))"
  else
    echo "FAIL: $dir expected $want, got exit=$got"
    bad=1
  fi
}

run_case pass pass          "$here/check-md-links.sh" .
run_case pass pass          "$here/check-md-tables.sh" .
run_case pass pass          "$here/check-glossary-coverage.sh" . GLOSSARY.md allowlist.txt
run_case fail fail-link     "$here/check-md-links.sh" .
run_case fail fail-table    "$here/check-md-tables.sh" .
run_case fail fail-glossary "$here/check-glossary-coverage.sh" . GLOSSARY.md allowlist.txt

# Ignored local workspaces are not repository content. One deliberately broken
# ignored Markdown file exercises all three gates; the tracked file stays valid.
ignored_root=$(mktemp -d)
trap 'rm -rf "$ignored_root"' EXIT
git -C "$ignored_root" init -q
printf '.context/\n' > "$ignored_root/.gitignore"
printf '# Good\n\nRepository content.\n' > "$ignored_root/README.md"
printf '# Glossary\n\nHITL is defined here.\n' > "$ignored_root/GLOSSARY.md"
printf '# none\n' > "$ignored_root/allowlist.txt"
mkdir -p "$ignored_root/.context"
printf '# Bad\nText\n| table |\n[missing](nowhere.md)\nUNDEFINEDTERM\n' > "$ignored_root/.context/ignored.md"
git -C "$ignored_root" add .gitignore README.md GLOSSARY.md allowlist.txt

for gate in check-md-links.sh check-md-tables.sh; do
  if "$here/$gate" "$ignored_root" >/dev/null 2>&1; then
    echo "ok: ignored workspace ($(basename "$gate"))"
  else
    echo "FAIL: ignored workspace affected $gate"
    bad=1
  fi
done
if "$here/check-glossary-coverage.sh" "$ignored_root" \
  "$ignored_root/GLOSSARY.md" "$ignored_root/allowlist.txt" >/dev/null 2>&1; then
  echo "ok: ignored workspace (check-glossary-coverage.sh)"
else
  echo "FAIL: ignored workspace affected check-glossary-coverage.sh"
  bad=1
fi

"$here/test-check-branch-protection.sh" || bad=1

exit "$bad"
