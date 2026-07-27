#!/usr/bin/env bash
# Read-only recheck for default-branch protection (an issue, M1 dogfooded).
#
# Host settings are a human's call — this script never writes them. It only
# reads the current state and reports each control the repo's default
# branch is expected to carry: a required, up-to-date CI check, at least
# one required human review, required conversation resolution,
# administrator enforcement, no force-push/deletion, and any bypass actors
# (so narrow bot exceptions stay visible instead of silently accumulating).
# When a gap exists it also prints the exact `gh api` command to close it,
# built from the *current* response with only the failing controls
# overridden, so a human approving the change is reviewing a targeted diff,
# not a replacement that could silently undo unrelated stricter settings.
#
# Usage:
#   check-branch-protection.sh                    # live: gh api against origin's repo + its default branch
#   check-branch-protection.sh owner/repo branch   # live: explicit target
#   check-branch-protection.sh --input FILE        # offline: evaluate a saved `.../protection` JSON response
#   check-branch-protection.sh --input -           # offline: read that JSON from stdin
#
# Exit: 0 every control satisfied, 1 a gap exists, 2 usage or fetch error.
set -euo pipefail

usage() {
  echo "usage: $0 [--input FILE|-] [owner/repo] [branch]" >&2
  exit 2
}

# Bound how long a live lookup can block: an agent or CI job invoking this
# should never hang indefinitely on a stalled network connection. Degrades
# to an unbounded call where `timeout` isn't available (e.g. bare macOS).
gh_api() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 15 gh api "$@"
  else
    gh api "$@"
  fi
}

input=""
positional=()
while [ $# -gt 0 ]; do
  case "$1" in
    --input)
      [ $# -ge 2 ] || usage
      input=$2
      shift 2
      ;;
    -h|--help) usage ;;
    *) positional+=("$1"); shift ;;
  esac
done
[ "${#positional[@]}" -le 2 ] || usage

repo="${positional[0]:-}"
branch="${positional[1]:-}"

unprotected=0
if [ -n "$input" ]; then
  # Offline mode evaluates a saved response and never touches the network,
  # so it must not require a resolvable GitHub origin — repo/branch here are
  # display-only labels.
  if [ "$input" = "-" ]; then
    json=$(cat)
  else
    [ -f "$input" ] && [ -r "$input" ] || { echo "error: cannot read input file '$input'" >&2; exit 2; }
    json=$(cat "$input")
  fi
  repo="${repo:-(offline input)}"
  branch="${branch:-main}"
else
  if [ -z "$repo" ]; then
    remote=$(git remote get-url origin 2>/dev/null || true)
    repo=$(printf '%s' "$remote" | sed -E 's#^(git@github\.com:|ssh://git@github\.com/|https://github\.com/)##; s#\.git$##')
  fi
  if ! [[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
    echo "error: could not parse an owner/repo from origin '${remote:-}' (expected a github.com remote); pass one explicitly" >&2
    exit 2
  fi
  command -v gh >/dev/null 2>&1 || { echo "error: gh CLI not found" >&2; exit 2; }
  if [ -z "$branch" ]; then
    branch=$(gh_api "repos/$repo" --jq .default_branch) || { echo "error: could not determine default branch for $repo (gh api failed or timed out)" >&2; exit 2; }
  fi
  errfile=$(mktemp) || { echo "error: could not create a temp file for gh api stderr" >&2; exit 2; }
  trap 'rm -f "$errfile"' EXIT
  if ! json=$(gh_api "repos/$repo/branches/$branch/protection" 2>"$errfile"); then
    if grep -q "HTTP 404" "$errfile"; then
      unprotected=1
      json='{}'
    else
      cat "$errfile" >&2
      exit 2
    fi
  fi
fi

if ! jq -e 'type == "object"' <<<"$json" >/dev/null 2>&1; then
  echo "error: expected a JSON object from the branch-protection response, got: $(printf '%.200s' "$json")" >&2
  exit 2
fi

# Every field a check(), report line, or remediation lookup treats as a
# specific type (array/boolean/number/object) must actually be that type —
# otherwise jq's cross-type comparisons and string methods (e.g. a string
# satisfies both `index("gates")` and `>= 1`) can turn a malformed response
# into a false PASS, or crash a later unguarded `jq` call under `set -e`.
type_errors=$(jq -r '
  def is_type(val; want): (val == null) or ((val | type) == want);
  [
    (if is_type(.required_status_checks.contexts; "array") then empty else "required_status_checks.contexts must be an array" end),
    (if is_type(.required_status_checks.strict; "boolean") then empty else "required_status_checks.strict must be a boolean" end),
    (if is_type(.required_pull_request_reviews.required_approving_review_count; "number") then empty else "required_pull_request_reviews.required_approving_review_count must be a number" end),
    (if is_type(.required_conversation_resolution.enabled; "boolean") then empty else "required_conversation_resolution.enabled must be a boolean" end),
    (if is_type(.enforce_admins.enabled; "boolean") then empty else "enforce_admins.enabled must be a boolean" end),
    (if is_type(.allow_force_pushes.enabled; "boolean") then empty else "allow_force_pushes.enabled must be a boolean" end),
    (if is_type(.allow_deletions.enabled; "boolean") then empty else "allow_deletions.enabled must be a boolean" end),
    (if is_type(.restrictions; "object") then empty else "restrictions must be an object or null" end),
    (if is_type(.required_pull_request_reviews.bypass_pull_request_allowances; "object") then empty else "required_pull_request_reviews.bypass_pull_request_allowances must be an object or null" end)
  ] | join("; ")
' <<<"$json" 2>/dev/null) || { echo "error: could not evaluate branch-protection JSON structure" >&2; exit 2; }
if [ -n "$type_errors" ]; then
  echo "error: branch-protection JSON has unexpected field types: $type_errors" >&2
  exit 2
fi

echo "Branch protection recheck — $repo@$branch"
if [ "$unprotected" = 1 ]; then
  echo "  branch is currently UNPROTECTED (404 from the protection endpoint)"
fi
echo ""

gaps=0
total=0
check() {  # check <label> <jq-bool-expr>
  local label=$1 expr=$2
  total=$((total + 1))
  if jq -e "$expr" <<<"$json" >/dev/null 2>&1; then
    printf '  PASS  %s\n' "$label"
  else
    printf '  FAIL  %s\n' "$label"
    gaps=$((gaps + 1))
  fi
}

check "required CI status check(s) configured"      '(.required_status_checks.contexts // []) | index("gates") != null'
check "required status checks are strict"            '.required_status_checks.strict == true'
check "at least one required human review"           '(.required_pull_request_reviews.required_approving_review_count // 0) >= 1'
check "required conversation resolution"             '.required_conversation_resolution.enabled == true'
check "administrator enforcement"                    '.enforce_admins.enabled == true'
check "force-push disallowed"                        '.allow_force_pushes.enabled == false'
check "branch deletion disallowed"                    '.allow_deletions.enabled == false'

contexts=$(jq -r '(.required_status_checks.contexts // []) | join(", ")' <<<"$json")
echo "  required checks: ${contexts:-none}"

restrictions=$(jq -r '
  if .restrictions == null then "none (no push-restriction bypass actors)"
  else [(.restrictions.users // [])[].login, (.restrictions.teams // [])[].slug, (.restrictions.apps // [])[].slug] | join(", ")
  end' <<<"$json")
echo "  bypass actors (restrictions): ${restrictions:-none}"

pr_bypass=$(jq -r '
  (.required_pull_request_reviews.bypass_pull_request_allowances) as $b
  | if $b == null then "none (no PR-review bypass actors)"
    else [($b.users // [])[].login, ($b.teams // [])[].slug, ($b.apps // [])[].slug] | join(", ")
    end' <<<"$json")
echo "  bypass actors (PR review bypass_pull_request_allowances): ${pr_bypass:-none}"
echo ""

if [ "$gaps" -gt 0 ] && [ -z "$input" ]; then
  echo "Recommended remediation — review, then a human runs:"
  echo ""
  echo "  gh api --method PUT repos/$repo/branches/$branch/protection \\"
  echo "    -H \"Accept: application/vnd.github+json\" --input - <<'JSON'"
  jq -n --argjson cur "$json" '
    def actors(x):
      if x == null then null
      else {
        users: [(x.users // [])[].login],
        teams: [(x.teams // [])[].slug],
        apps: [(x.apps // [])[].slug]
      }
      end;
    ($cur.required_status_checks // {}) as $rsc |
    ($cur.required_pull_request_reviews // {}) as $rpr |
    ($cur.restrictions) as $restr |
    (
      ($rsc.checks // (($rsc.contexts // []) | map({context: ., app_id: null})))
    ) as $existingChecks |
    {
      required_status_checks: {
        strict: true,
        contexts: ((($rsc.contexts // []) + ["gates"]) | unique),
        checks: (
          if ($existingChecks | map(.context) | index("gates")) then $existingChecks
          else $existingChecks + [{context: "gates", app_id: null}]
          end
        )
      },
      enforce_admins: true,
      required_pull_request_reviews: (
        {
          required_approving_review_count: (if (($rpr.required_approving_review_count // 0) >= 1) then $rpr.required_approving_review_count else 1 end),
          dismiss_stale_reviews: ($rpr.dismiss_stale_reviews // false),
          require_code_owner_reviews: ($rpr.require_code_owner_reviews // false),
          require_last_push_approval: ($rpr.require_last_push_approval // false)
        }
        + (if $rpr.bypass_pull_request_allowances then {bypass_pull_request_allowances: actors($rpr.bypass_pull_request_allowances)} else {} end)
        + (if $rpr.dismissal_restrictions then {dismissal_restrictions: actors($rpr.dismissal_restrictions)} else {} end)
      ),
      required_conversation_resolution: true,
      restrictions: actors($restr),
      allow_force_pushes: false,
      allow_deletions: false,
      required_linear_history: (($cur.required_linear_history.enabled) // false),
      block_creations: (($cur.block_creations.enabled) // false),
      lock_branch: (($cur.lock_branch.enabled) // false),
      allow_fork_syncing: (($cur.allow_fork_syncing.enabled) // false)
    }
  '
  echo "JSON"
  echo ""
  echo "This preserves every current setting not covered by a failing control above"
  echo "(dismiss/code-owner/last-push review requirements, dismissal restrictions,"
  echo "PR-bypass allowances, which GitHub App satisfies each required check,"
  echo "push-restriction actors, linear-history, lock-branch, fork-syncing, and"
  echo "creation restrictions) and only forces the failing ones into compliance."
  echo "Re-run this script afterward to confirm the recheck goes all-PASS."
fi

echo "$((total - gaps))/$total controls satisfied"
[ "$gaps" -eq 0 ]
