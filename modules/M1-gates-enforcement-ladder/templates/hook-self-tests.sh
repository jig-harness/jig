#!/usr/bin/env bash
# Run every agent-runtime hook's self-test: the one runner CI calls, so a new
# hook enters the gate by having a test beside it, with no list to maintain.
#
# Usage: hook-self-tests.sh [<hooks-dir>]        default: .claude/hooks
#
# A hook is a *.sh or *.ts file in the directory; its test is <hook>.test.sh
# (run with bash) or <hook>.test.ts (run with `bun test`), beside the hook or
# under <hooks-dir>/__tests__/. Every test that can run, runs, and the exit
# is decided once at the end: 1 when a test failed or a hook has no test;
# otherwise 2 when the directory does not exist or holds no hook (a runner
# pointed at nothing must not pass) or a *.test.ts test could not run
# because `bun` is not on PATH; otherwise 0.
#
# The practice: https://github.com/jig-harness/jig/blob/main/modules/M1-gates-enforcement-ladder/README.md
set -uo pipefail

dir="${1:-.claude/hooks}"
if [ ! -d "$dir" ]; then
  echo "hook-self-tests: could not check: no directory $dir" >&2
  exit 2
fi

hooks=0 tests=0 failed=0 untested=0
for hook in "$dir"/*.sh "$dir"/*.ts; do
  [ -f "$hook" ] || continue
  case "$hook" in *.test.sh | *.test.ts) continue ;; esac
  hooks=$((hooks + 1))
  base="$(basename "${hook%.*}")"
  found=0
  for candidate in "$dir/$base.test.sh" "$dir/$base.test.ts" \
    "$dir/__tests__/$base.test.sh" "$dir/__tests__/$base.test.ts"; do
    [ -f "$candidate" ] && found=1
  done
  if [ "$found" -eq 0 ]; then
    echo "hook-self-tests: $hook has no test beside it or under $dir/__tests__/" >&2
    untested=$((untested + 1))
  fi
done
if [ "$hooks" -eq 0 ]; then
  echo "hook-self-tests: could not check: no hook in $dir" >&2
  exit 2
fi

has_bun=0
command -v bun >/dev/null 2>&1 && has_bun=1

unrun=0
for test in "$dir"/*.test.sh "$dir"/*.test.ts \
  "$dir"/__tests__/*.test.sh "$dir"/__tests__/*.test.ts; do
  [ -f "$test" ] || continue
  case "$test" in *.ts)
    if [ "$has_bun" -eq 0 ]; then
      echo "hook-self-tests: could not check: $test needs bun, which is not on PATH" >&2
      unrun=$((unrun + 1))
      continue
    fi
    ;;
  esac
  tests=$((tests + 1))
  case "$test" in
    *.sh) bash "$test" ;;
    *.ts) bun test "$test" ;;
  esac || {
    echo "hook-self-tests: FAILED $test" >&2
    failed=$((failed + 1))
  }
done

echo "hook-self-tests: $hooks hook(s), $tests test(s), $failed failed, $untested without a test, $unrun could not run"
if [ "$failed" -gt 0 ] || [ "$untested" -gt 0 ]; then exit 1; fi
if [ "$unrun" -gt 0 ]; then exit 2; fi
exit 0
