#!/usr/bin/env bash
# PR-target safety lint: fork-unsafe reviewer wiring must fail loudly.
#
# The problem it catches. An automated reviewer needs repository secrets (model
# keys, a bot token) to post its findings, so its workflow runs with the
# `pull_request_target` trigger — which executes in the BASE repo's privileged
# context (secrets + a write token) even for PRs from forks. If such a workflow
# ALSO checks out the untrusted PR head / fork code AND then runs code (a
# `run:` step, or an `npm install` firing lifecycle scripts), a forked PR can
# exfiltrate those secrets. This is a well-known CI foot-gun, not a hypothetical.
#
# The safe pattern (see README): under `pull_request_target`, treat fork code
# as DATA — analyze the diff, don't execute the PR's own code in the privileged
# job. A reviewer that must run the PR's build belongs on the `pull_request`
# trigger (no secrets) with results handed back via artifacts.
#
# What this flags — a workflow where ALL THREE hold:
#   1. it is triggered by `pull_request_target`, AND
#   2. it checks out an untrusted head/fork ref (a `ref:`/`repository:` line
#      referencing github.event.pull_request.head.* or github.head_ref), AND
#   3. it has at least one `run:` step (code execution).
# High-recall by design: a false positive is a two-line review; a false
# negative is a leaked secret. A workflow that omits any of the three passes.
#
# Conventions (see ../../../M1-gates-enforcement-ladder/reference/grep-gate):
# exit 0 on pass, 1 on an unsafe workflow (per-file report), 2 on a usage
# error; inputs via args or WORKFLOWS_DIR so the self-test drives it with
# fixtures. A missing workflows dir passes (safe to wire early).
#
# Usage:
#   check-pr-target-safety.sh                       # scan .github/workflows
#   check-pr-target-safety.sh path/to/wf.yml ...    # explicit files
#   WORKFLOWS_DIR=path check-pr-target-safety.sh
set -u
WORKFLOWS_DIR="${WORKFLOWS_DIR:-.github/workflows}"

# An explicit checkout of PR head / fork code — the untrusted-ref expressions a
# `ref:`/`repository:` key may carry, inline OR (folded/block scalar) on the
# lines beneath it. A line-oriented grep misses the multiline form:
#     ref: >-
#       ${{ github.event.pull_request.head.sha }}
# so we scan with a small indent-aware state machine and fail closed on it.
has_untrusted_ref() { # <file> -> 0 if a checkout of untrusted head/fork ref
  awk '
    function untrusted(s){ return s ~ /github\.event\.pull_request\.head\.(sha|ref|repo)|github\.head_ref/ }
    {
      line=$0; sub(/[[:space:]]+#.*$/,"",line)          # drop an inline comment
      match(line, /^[[:space:]]*/); ind=RLENGTH
      if (inblk) {
        if (line ~ /^[[:space:]]*$/) next               # blank line stays in block
        if (ind > blkind) { if (untrusted(line)) { hit=1; exit } ; next }
        inblk=0                                          # dedent ends the block
      }
      if (line ~ /^[[:space:]]*(-[[:space:]]+)?[\047"]?(ref|repository)[\047"]?[[:space:]]*:/) {
        val=line; sub(/^[[:space:]]*(-[[:space:]]+)?[\047"]?(ref|repository)[\047"]?[[:space:]]*:[[:space:]]*/,"",val)
        if (untrusted(val)) { hit=1; exit }
        if (val ~ /^[|>]/ || val=="") { inblk=1; blkind=ind }   # folded/block/empty scalar
      }
    }
    END { exit(hit?0:1) }
  ' "$1"
}

# Code execution out of the checkout: a `run:` step, OR a LOCAL action
# (`uses: ./...`) — a local action is loaded and executed from the (untrusted)
# checkout just like a run: step, so it is the same exfiltration path. Remote
# `uses: owner/repo@ref` actions are pinned, not fork-controlled, so ignore
# them. Keys may be quoted (`"run"` / `"uses"`), so allow an optional quote.
executes_checkout_code() { # <file> -> 0 if it runs code from the checkout
  grep -Eq "^[[:space:]]*(-[[:space:]]+)?[\"']?run[\"']?[[:space:]]*:" "$1" && return 0
  grep -Eq "^[[:space:]]*(-[[:space:]]+)?[\"']?uses[\"']?[[:space:]]*:[[:space:]]*[\"']?\\./" "$1" && return 0
  return 1
}

is_unsafe() { # <file> -> 0 if the three dangerous conditions all hold
  local f="$1"
  grep -q 'pull_request_target' "$f" || return 1
  has_untrusted_ref "$f" || return 1
  executes_checkout_code "$f" || return 1
  return 0
}

# ---- collect files ---------------------------------------------------------
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  if [ ! -d "$WORKFLOWS_DIR" ]; then
    echo "OK — $WORKFLOWS_DIR does not exist (no workflows to check)"
    exit 0
  fi
  # The dir exists: a find that FAILS (e.g. unreadable) must not masquerade as
  # "no workflows found". Capture its status and fail closed on any error —
  # only a genuinely absent directory (handled above) is allowed to pass empty.
  if ! found=$(find "$WORKFLOWS_DIR" -maxdepth 1 \( -name '*.yml' -o -name '*.yaml' \) 2>&1); then
    echo "ERROR: cannot scan $WORKFLOWS_DIR: $found" >&2
    exit 2
  fi
  files=()
  while IFS= read -r line; do
    [ -n "$line" ] && files+=("$line")
  done <<< "$found"
fi

bad=0
for f in "${files[@]:-}"; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || { echo "ERROR: not a file: $f" >&2; exit 2; }
  if is_unsafe "$f"; then
    echo "UNSAFE $f"
    echo "  pull_request_target + checkout of untrusted head/fork code + a run: step."
    echo "  A forked PR can exfiltrate this job's secrets."
    echo "  Fix: under pull_request_target, check out the BASE ref only and treat"
    echo "       fork code as data; run the PR's own code on the pull_request"
    echo "       trigger (no secrets) and pass results back via artifacts."
    echo ""
    bad=1
  fi
done

if [ "$bad" -ne 0 ]; then
  echo "PR-target safety lint FAILED — fork-unsafe reviewer wiring found."
  exit 1
fi
echo "OK — no fork-unsafe pull_request_target workflows"
