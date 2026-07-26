#!/usr/bin/env bash
# Review-round convergence: may this review loop stop, keep going, wait, or is it
# already pointless?
#
# A push that resolves one round of review comments re-triggers the reviewers and
# produces the next round, so the loop's stop condition is not "are there open
# threads?". That question is wrong in two directions, and both failures are
# silent — no error is raised in either case:
#
#   * Zero open threads while a reviewer is still running is NOT convergence.
#     That round's comments have not posted yet. Stopping there abandons live
#     findings and looks exactly like success.
#   * A merge (or close) that lands mid-loop orphans every later fix onto a
#     branch nothing will merge. Liveness has to be re-checked each round, not
#     assumed from the round before.
#
# Both are properties of any asynchronous review loop, not of a forge or a bot,
# which is why this is a portable gate over a tiny exported status file rather
# than a forge API script.
#
# Input: a status file, `key: value` per line (see ../../mappings.md for producing it):
#     pr_state:      open | merged | closed
#     open_threads:  count of threads not yet terminal — count every thread the
#                    merge gate would REJECT, not only those marked `open`
#     round:         1-based round counter, carried by the caller (>= 1)
#     reviewer:      <identity> <reported|pending>   — repeated, one per reviewer
# Counts are canonical decimal: no leading zeros, which bash reads as octal. The
# first three keys are required and appear exactly once; at least one `reviewer:`
# line is required. A missing key is schema drift, and defaulting one would
# manufacture the very confidence this gate exists to withhold. Blank lines and
# `# comments` are ignored.
#
# Reviewers are IDENTITIES, deliberately, not a pair of counts. Two counts look
# simpler and are quietly wrong: a bot that leaves two artifacts behind — a check
# run AND a posted review — gets counted twice by any naive producer, so with one
# bot finished and one human still pending you get 2 of 2 reported and a false
# CONVERGED. One settled signal per identity makes that unrepresentable, and a
# repeated identity is an error rather than a second vote. It also means
# "reported exceeds expected" cannot happen by construction.
#
# Output: one machine-readable decision line on stdout (the reasoning goes to
# stderr), so a caller can act on it and a learning loop can consume the round
# count from it (M8's reflection trigger does exactly that):
#     <DECISION> round=<n> open_threads=<n> reviewers=<reported>/<expected> pr_state=<s>
#
# Decisions and exit codes:
#     CONVERGED  0  settled, everyone reported, nothing open — the loop may stop
#     WORK       1  threads to resolve; fix them, push, and run the next round
#     WAIT       3  nothing open but the round has not settled — do NOT stop
#     ABORT      4  the PR is no longer open; stop, do not push
#     (usage / format error exits 2, per the other gates here)
#
# Order is deliberate: liveness first (a merged PR makes every other question
# moot), then work-in-hand, then settling. WORK outranks WAIT because open
# threads are worth resolving whether or not the round has finished arriving;
# WAIT is reserved for the case that actually misleads — an empty thread list.
#
# Usage:
#   check-round-converged.sh round-status.txt
#   STATUS=round-status.txt check-round-converged.sh
set -u
STATUS="${1:-${STATUS:-}}"

[ -n "$STATUS" ] || { echo "ERROR: no status file given (arg or STATUS=)" >&2; exit 2; }
[ -f "$STATUS" ] || { echo "ERROR: status file not found: $STATUS" >&2; exit 2; }

pr_state="" open_threads="" round=""
seen_pr_state="" seen_open_threads="" seen_round=""
reviewers_expected=0 reviewers_reported=0
seen_reviewers="" pending_reviewers=""
err=0

trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; printf '%s' "${s%"${s##*[![:space:]]}"}"; }

while IFS= read -r raw || [ -n "$raw" ]; do
  line=$(trim "$raw")
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in
    *:*) ;;
    *) echo "ERROR: not a 'key: value' line: $line" >&2; err=1; continue ;;
  esac
  key=$(trim "${line%%:*}"); val=$(trim "${line#*:}")
  case "$key" in
    pr_state|open_threads|round)
      # A duplicate key means two producers disagree; last-wins would hide that.
      # Presence is tracked SEPARATELY from value: keying the check on "is the
      # value still empty" makes `pr_state:` followed by `pr_state: open` look
      # like a first declaration, so the malformed line vanishes and the file
      # passes — the schema says exactly once, and an empty value is not a value.
      seen_key="seen_$key"
      if [ -n "${!seen_key}" ]; then
        echo "ERROR: duplicate key: $key" >&2; err=1; continue
      fi
      eval "$seen_key=1"
      if [ -z "$val" ]; then
        echo "ERROR: key '$key' declared with no value" >&2; err=1; continue
      fi
      eval "$key=\$val" ;;   # key is one of the three literals matched above
    reviewer)
      ident=$(trim "${val%% *}"); rstate=$(trim "${val#* }")
      if [ -z "$ident" ] || [ "$ident" = "$rstate" ]; then
        echo "ERROR: reviewer needs '<identity> <reported|pending>', got '$val'" >&2; err=1; continue
      fi
      # An identity has to be a stable token so it can be compared; a sentence
      # cannot be deduplicated against the next round's spelling of it.
      if ! [[ "$ident" =~ ^[A-Za-z0-9][A-Za-z0-9._@/+-]*$ ]]; then
        echo "ERROR: reviewer identity must be a plain token, got '$ident'" >&2; err=1; continue
      fi
      # The dedup that makes "everyone reported" mean something. A bot leaving
      # both a check run and a posted review must not become two reviewers.
      case " $seen_reviewers " in
        *" $ident "*) echo "ERROR: duplicate reviewer identity: $ident" >&2; err=1; continue ;;
      esac
      seen_reviewers="$seen_reviewers $ident"
      case "$rstate" in
        reported) reviewers_expected=$((reviewers_expected + 1)); reviewers_reported=$((reviewers_reported + 1)) ;;
        pending)  reviewers_expected=$((reviewers_expected + 1)); pending_reviewers="$pending_reviewers $ident" ;;
        *) echo "ERROR: reviewer $ident state must be reported or pending, got '$rstate'" >&2; err=1 ;;
      esac ;;
    *) echo "ERROR: unknown key: $key" >&2; err=1 ;;
  esac
done < "$STATUS"

for key in pr_state open_threads round; do
  [ -n "${!key}" ] || { echo "ERROR: missing required key: $key" >&2; err=1; }
done
# Zero reviewers is not convergence, it is an unenumerated producer. A loop that
# declares a review settled without naming a single reviewer settled nothing.
[ "$reviewers_expected" -gt 0 ] || { echo "ERROR: no 'reviewer:' lines — name at least one reviewer, or the round has nothing to settle" >&2; err=1; }
# `open_threads` must be CANONICAL decimal. A leading zero is not merely untidy:
# bash arithmetic reads `08` as octal, so the comparison below would die with
# "value too great for base" and the gate would emit no decision at all — the one
# outcome a gate whose exit code is control flow must never have.
[ -z "$open_threads" ] || [[ "$open_threads" =~ ^(0|[1-9][0-9]*)$ ]] || { echo "ERROR: open_threads must be a canonical non-negative integer, no leading zeros, got '$open_threads'" >&2; err=1; }
# `round` is 1-based, per the input contract. A 0th round is not a round, and
# admitting it lets CONVERGED be reported for a loop that never ran a pass — an
# invalid measurement that then flows on to M8's reflection trigger.
[ -z "$round" ] || [[ "$round" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: round must be an integer >= 1 (it is 1-based), got '$round'" >&2; err=1; }
case "${pr_state:-open}" in
  open|merged|closed) ;;
  *) echo "ERROR: pr_state must be open, merged or closed, got '$pr_state'" >&2; err=1 ;;
esac
[ "$err" -eq 0 ] || exit 2

decide() { # <DECISION> <exit> <reasoning>
  printf '%s round=%s open_threads=%s reviewers=%s/%s pr_state=%s\n' \
    "$1" "$round" "$open_threads" "$reviewers_reported" "$reviewers_expected" "$pr_state"
  printf '%s\n' "$3" >&2
  exit "$2"
}

if [ "$pr_state" != open ]; then
  decide ABORT 4 "PR is $pr_state — stop the loop; a fix pushed now lands on a branch nothing will merge."
fi
if [ "$open_threads" -gt 0 ]; then
  decide WORK 1 "$open_threads thread(s) to resolve — fix them, push, then run round $((round + 1))."
fi
if [ "$reviewers_reported" -lt "$reviewers_expected" ]; then
  decide WAIT 3 "No open threads, but only $reviewers_reported of $reviewers_expected named reviewers have reported — still pending:${pending_reviewers}. This is not convergence yet."
fi
decide CONVERGED 0 "Round $round settled with all $reviewers_expected named reviewers reported and no open threads — the loop may stop."
