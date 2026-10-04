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

run_code() {  # run_code <exit-code> <fixture-dir> <cmd...> — exact status
  local want=$1 dir=$2; shift 2
  local got=0
  (cd "$fx/$dir" && "$@" >/dev/null 2>&1) || got=$?
  if [ "$got" -eq "$want" ]; then
    echo "ok: $dir ($(basename "$1"), exit $want)"
  else
    echo "FAIL: $dir expected exit $want, got exit=$got"
    bad=1
  fi
}

run_case pass pass          "$here/check-md-links.sh" .
run_case pass pass          "$here/check-md-tables.sh" .
run_case pass pass          "$here/check-glossary-coverage.sh" . GLOSSARY.md allowlist.txt
run_case fail fail-link     "$here/check-md-links.sh" .
run_case fail fail-table    "$here/check-md-tables.sh" .
run_case fail fail-glossary "$here/check-glossary-coverage.sh" . GLOSSARY.md allowlist.txt
run_code 0 pass            "$here/check-no-tracker-refs.sh" .
run_code 1 fail-tracker "$here/check-no-tracker-refs.sh" .
run_code 1 fail-tracker-link "$here/check-no-tracker-refs.sh" .
run_code 1 fail-tracker-unicode "$here/check-no-tracker-refs.sh" .
run_code 1 fail-tracker-basename "$here/check-no-tracker-refs.sh" .
run_code 2 fail-tracker-badregex "$here/check-no-tracker-refs.sh" . patterns.txt
run_code 2 pass            "$here/check-no-tracker-refs.sh" ./does-not-exist
run_code 2 fail-tracker-multipattern "$here/check-no-tracker-refs.sh" . patterns.txt

# An unreadable pattern file is an error, never "no patterns, nothing to do".
if [ "$(id -u)" -ne 0 ]; then
  pat_dir=$(mktemp -d)
  printf 'DOC-[0-9]+\n' > "$pat_dir/patterns.txt"
  chmod 000 "$pat_dir/patterns.txt"
  got=0
  "$here/check-no-tracker-refs.sh" "$fx/pass" "$pat_dir/patterns.txt" >/dev/null 2>&1 || got=$?
  chmod 644 "$pat_dir/patterns.txt"
  rm -rf "$pat_dir"
  if [ "$got" -eq 2 ]; then
    echo "ok: unreadable pattern file (check-no-tracker-refs.sh, exit 2)"
  else
    echo "FAIL: unreadable pattern file expected exit 2, got exit=$got"
    bad=1
  fi
fi

# A tracked file behind an unsearchable directory is unreadable, not deleted:
# the tracker gate must fail closed (exit 2), never skip it. Root ignores
# permission bits, so the case only runs unprivileged.
if [ "$(id -u)" -ne 0 ]; then
  perm_root=$(mktemp -d)
  git -C "$perm_root" init -q
  mkdir -p "$perm_root/locked"
  # The key is assembled at run time so this file stays clean for the gate.
  printf 'See %s-1 for why.\n' DOC > "$perm_root/locked/notes.md"
  git -C "$perm_root" add locked/notes.md
  chmod 000 "$perm_root/locked"
  got=0
  "$here/check-no-tracker-refs.sh" "$perm_root" >/dev/null 2>&1 || got=$?
  chmod 755 "$perm_root/locked"
  rm -rf "$perm_root"
  if [ "$got" -eq 2 ]; then
    echo "ok: unsearchable directory (check-no-tracker-refs.sh, exit 2)"
  else
    echo "FAIL: unsearchable directory expected exit 2, got exit=$got"
    bad=1
  fi
else
  echo "skip: unsearchable directory (running as root)"
fi

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
