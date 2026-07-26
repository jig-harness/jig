#!/usr/bin/env bash
# Verdict exporter: forge thread rows -> the unresolved-threads gate's input.
#
# The gate (./check-threads-resolved.sh) reads a CLOSED vocabulary as the first
# whitespace-delimited token of each line. A forge hands you a boolean plus a
# free-text reply. Nothing in between happens by itself: `**accepted** — fixed in
# a1b2c3d` is not the token `addressed`, a trailing `Verdict: deferred` is not
# first, and a reply that declares nothing is not a state at all. Dropping the
# reply body in verbatim makes every one of those an unknown state — the gate
# fails, but for the wrong reason and with no way to tell a typo from a
# convention mismatch.
#
# This script is that missing step, and it is the ONLY place the reply encoding
# is decoded: one adapter per repo, not one per workflow.
#
# Input: TAB-separated rows from your forge (see ../../mappings.md):
#     <thread-id>\t<resolved: true|false>\t<reply body, newlines flattened>
# A thread id may repeat across consecutive rows — its replies, NEWEST FIRST — and
# the freshest reply that actually declares a verdict wins. Sending only the last
# comment loses verdicts: a reviewer answering "confirmed" after the author's
# `**accepted** — fixed in a1b2c3d` would export as `unclassified` and block a
# correctly resolved thread. One row per thread still behaves as it always did.
# Blank lines and `# comments` are ignored.
#
# Output (stdout): the gate's states file, `<thread-id> <state> [trail...]`.
#
# Encodings (VERDICT_ENCODING, default `token`):
#     token     leading verdict word, markdown emphasis and trailing punctuation
#               stripped:   `**accepted** — added the guard in a1b2c3d`
#     trailer   trailing `Verdict: <state>` — flattening a multi-line reply turns
#               "on its own line" into "at the end of the body", so with this
#               encoding the trailer must be the LAST thing in the reply
#
# Both are ANCHORED — start of body, or end of body. Neither searches for a state
# word anywhere in the text, because an unanchored match reads narration as a
# verdict: a reply explaining why something was intended contains "intended"
# long after its actual verdict. A forge that models a real verdict field (a
# label, a reaction) is better than either; none of the forges in ../../mappings.md
# does today, so fetch that field and extend `canon()` if yours is the exception.
#
# A resolved thread whose verdict cannot be read emits `unclassified`, which the
# gate fails with its own message. That is deliberate: "cannot tell" is its own
# value, and folding it into a real state is the same corruption as scoring a
# `moot` as a rejection, one layer down.
#
# Synonyms live HERE. An adopting repo whose tooling says `accepted` / `wontfix` /
# `obsolete` maps them in `canon()` below — the exporter is already forge- and
# repo-specific, and the gate's vocabulary stays closed.
#
# Conventions: exit 0 on success, 2 on a usage / input-format error. Rows file
# via arg or ROWS env so the self-test drives it with fixtures.
#
# Usage:
#   normalize-thread-states.sh pr-thread-rows.tsv > pr-threads.txt
#   VERDICT_ENCODING=trailer ROWS=rows.tsv normalize-thread-states.sh > states.txt
set -u
ROWS="${1:-${ROWS:-}}"
ENCODING="${VERDICT_ENCODING:-token}"

case "$ENCODING" in
  token|trailer) ;;
  *) echo "ERROR: VERDICT_ENCODING must be token or trailer: $ENCODING" >&2; exit 2 ;;
esac
[ -n "$ROWS" ] || { echo "ERROR: no rows file given (arg or ROWS=)" >&2; exit 2; }
[ -f "$ROWS" ] || { echo "ERROR: rows file not found: $ROWS" >&2; exit 2; }

# The one place a repo's own vocabulary is mapped onto the gate's closed set.
# Empty result = "not a verdict word", which becomes `unclassified`.
canon() { # <raw word> -> gate state, or empty
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    addressed|accepted|fixed|done)     echo addressed ;;
    rejected|wontfix|declined|invalid) echo rejected ;;
    deferred|followup|follow-up)       echo deferred ;;
    moot|obsolete|superseded)          echo moot ;;
    *)                                 echo "" ;;
  esac
}

# Strip a leading run of separator punctuation left behind by the verdict token
# (`**accepted** — the rest` -> `the rest`) so the trail reads as the gate's
# audit trail rather than starting with a dash.
trim_separator() { printf '%s' "$1" | sed -E 's/^[[:space:]]*([-—–:,.|·]+[[:space:]]*)?//; s/[[:space:]]+$//'; }

# A thread id may appear on SEVERAL rows — its replies, NEWEST FIRST — and the
# first one that decodes wins. The newest reply is not reliably the verdict: a
# reviewer answering "confirmed" after the author's `**accepted** — fixed in
# abc1234` would otherwise discard the verdict and block a correctly resolved
# thread as `unclassified`. Scanning newest-first means the freshest *declared*
# verdict wins while acknowledgements, questions and thanks are passed over.
# A single row per thread still behaves exactly as before.
pend_id="" pend_state="" pend_trail="" pend_newest=""

flush() { # emit the decision for the buffered thread, if any
  [ -n "$pend_id" ] || return 0
  if [ -n "$pend_state" ]; then
    if [ -n "$pend_trail" ]; then printf '%s %s %s\n' "$pend_id" "$pend_state" "$pend_trail"
    else                         printf '%s %s\n'    "$pend_id" "$pend_state"; fi
  # No reply decoded. Keep the NEWEST body as the trail: whoever reads the gate
  # failure needs to see what the last word on the thread actually was.
  elif [ -n "$pend_newest" ]; then printf '%s unclassified %s\n' "$pend_id" "$pend_newest"
  else                             printf '%s unclassified\n'    "$pend_id"
  fi
  pend_id="" pend_state="" pend_trail="" pend_newest=""
}

err=0
while IFS=$'\t' read -r id resolved body || [ -n "$id" ]; do
  case "$id" in ''|'#'*) continue ;; esac
  # Flatten defensively: the gate is whitespace-delimited, so a stray newline or
  # tab surviving the API call would split one thread across two rows.
  body=$(printf '%s' "$body" | tr -s '[:space:]' ' ' | sed -E 's/^ //; s/ $//')

  [ "$id" = "$pend_id" ] || { flush; pend_id="$id"; }

  case "$resolved" in
    true) ;;
    false) pend_state=open; continue ;;
    # Anything else is schema drift, not a thread to guess about: a missing
    # column would silently make every thread "not resolved" and pass nothing.
    *) echo "ERROR: $id — resolved column must be true or false, got '$resolved'" >&2; err=1; continue ;;
  esac

  [ -n "$pend_newest" ] || pend_newest="$body"   # first row for this id = newest reply
  [ -z "$pend_state" ] || continue               # already decided by a newer reply

  word="" trail=""
  if [ "$ENCODING" = token ]; then
    lead="${body%%[[:space:]]*}"          # anchored: the first token, nothing else
    word="${lead//[\*\_\`]/}"             # markdown emphasis is cosmetic
    word="${word%%[^[:alnum:]-]*}"        # `accepted:` -> accepted
    trail=$(trim_separator "${body#"$lead"}")
  elif [[ "$body" =~ ^(.*)[Vv]erdict:[[:space:]]*([A-Za-z-]+)[[:space:]]*[.]?$ ]]; then
    trail=$(trim_separator "${BASH_REMATCH[1]}")
    word="${BASH_REMATCH[2]}"
  fi

  state=$(canon "$word")
  # No verdict in THIS reply is not a decision — an older reply may carry one, so
  # leave the thread undecided and let `flush` fall back to `unclassified`.
  if [ -n "$state" ]; then pend_state="$state" pend_trail="$trail"; fi
done < "$ROWS"
flush

exit $((err ? 2 : 0))
