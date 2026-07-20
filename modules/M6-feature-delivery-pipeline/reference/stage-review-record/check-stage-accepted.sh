#!/usr/bin/env bash
# Stage-review-record gate — an accepted artifact proves it was reviewed.
#
# The pipeline invariant: an artifact is adversarially reviewed (fresh context,
# red-team posture) BEFORE the next stage consumes it. "Consumable" is marked in
# frontmatter as `status: accepted`. This gate makes the review non-skippable:
# an artifact that claims `status: accepted` MUST also carry a review record.
#
# A review record is EITHER:
#   * a `reviewed:` frontmatter key whose value carries a reviewer plus an
#     anchor proving when/where — a date (YYYY-MM-DD), an issue/PR ref (#123), a
#     URL, or a commit sha; a bare `reviewed: true` does not count, OR
#   * a non-empty `## Review` section in the body (a heading whose text starts
#     with "Review", followed by at least one non-blank content line).
#
# Verdict:
#   status not accepted (draft / proposed / absent)  -> pass  (nothing to prove)
#   status accepted WITH a review record             -> pass
#   status accepted WITHOUT a review record          -> FAIL  (exit 1)
#   frontmatter opened with `---` but never closed   -> error (exit 2)
#
# De-scarring (M4) keeps the finished artifact clean, so the record stays terse
# — a reviewer and an anchor, not the review dialogue. Input: the artifact via
# arg 1 or ARTIFACT env. Conventions: exit 0 pass, 1 accepted-but-unreviewed, 2
# usage/format error.
#
# Usage:
#   check-stage-accepted.sh prd.md
#   ARTIFACT=prd.md check-stage-accepted.sh
set -u
ARTIFACT="${1:-${ARTIFACT:-}}"

[ -n "$ARTIFACT" ] || { echo "ERROR: no artifact file given (arg 1 or ARTIFACT=)" >&2; exit 2; }
[ -f "$ARTIFACT" ] || { echo "ERROR: artifact not found: $ARTIFACT" >&2; exit 2; }

awk '
  function trim(s){ gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
  BEGIN{ fm=0; closed=0; status=""; reviewed=""; body=0; infence=0;
         inreview=0; reviewcontent=0; inhtml=0; nstatus=0; nreviewed=0 }
  {
    if (NR==1) {
      if ($0 ~ /^---[[:space:]]*$/) { fm=1; next }   # enter frontmatter
      else { body=1 }                                # no frontmatter at all
    }
    if (fm==1 && closed==0 && NR>1) {
      if ($0 ~ /^---[[:space:]]*$/) { closed=1; body=1; next }   # close frontmatter
      if ($0 ~ /^[[:space:]]*status[[:space:]]*:/) {
        nstatus++                                    # duplicate frontmatter key
        v=$0; sub(/^[[:space:]]*status[[:space:]]*:[[:space:]]*/, "", v)
        sub(/[[:space:]]+#.*$/, "", v); gsub(/["'"'"']/, "", v)
        status=tolower(trim(v))
      } else if ($0 ~ /^[[:space:]]*reviewed[[:space:]]*:/) {
        nreviewed++
        v=$0; sub(/^[[:space:]]*reviewed[[:space:]]*:[[:space:]]*/, "", v)
        v=trim(v)
        # Normalize like status: YAML parses `reviewed: true # Alice #123` as
        # `true` — the rest is a comment, not a review record. A quoted scalar
        # keeps only its quoted content (a comment sits after the closing quote);
        # an unquoted scalar drops a ` #...` inline comment. Keeps a real
        # anchor like a quoted "..., #418" intact while killing a faked one.
        c=substr(v,1,1)
        if (c=="\042")      { v=substr(v,2); sub("\042.*$", "", v) }
        else if (c=="\047") { v=substr(v,2); sub("\047.*$", "", v) }
        else                { sub(/[[:space:]]+#.*$/, "", v) }
        reviewed=trim(v)
      }
      next
    }
    if (body==1) {
      bl = $0
      # HTML comments (outside fenced code) are not rendered: a `## Review`
      # heading or "content" hiding in a <!-- ... --> block must not count. Strip
      # single-line comments and track a multi-line one.
      if (!infence) {
        if (inhtml) { if (bl ~ /-->/) { sub(/^.*-->/, "", bl); inhtml=0 } else next }
        gsub(/<!--.*-->/, "", bl)
        if (bl ~ /<!--/) { sub(/<!--.*$/, "", bl); inhtml=1 }
      }
      # The fence line itself is NOT content — an empty ```/``` block must not
      # count as a review record. Only a non-blank line (inside or outside a
      # fence) sets reviewcontent.
      if (bl ~ /^[[:space:]]*(```|~~~)/) { infence = !infence; next }
      if (infence) { if (inreview && bl !~ /^[[:space:]]*$/) reviewcontent=1; next }
      if (bl ~ /^##[[:space:]]+[Rr]eview/) { inreview=1; next }   # the Review section opens
      if (bl ~ /^#{1,2}[[:space:]]+/)      { inreview=0; next }   # any other L1/L2 heading closes it
      if (inreview && bl !~ /^[[:space:]]*$/) reviewcontent=1
    }
  }
  END{
    if (fm==1 && closed==0) {
      print "ERROR: malformed frontmatter (opened with --- but never closed): " FILENAME > "/dev/stderr"
      exit 2
    }
    # A duplicate frontmatter key last-wins: `status: accepted` then
    # `status: draft` (or a second `reviewed:`) could flip an accepted artifact
    # to non-accepted, or blank a real review record. Reject repeats.
    if (nstatus > 1)   { print "ERROR: duplicate 'status:' key in frontmatter: "   FILENAME > "/dev/stderr"; exit 2 }
    if (nreviewed > 1) { print "ERROR: duplicate 'reviewed:' key in frontmatter: " FILENAME > "/dev/stderr"; exit 2 }
    # The contract is reviewer PLUS anchor: an accountable WHO and a WHEN/WHERE.
    # A lone anchor (`reviewed: 2026-07-20`, or just `#123` / a URL) names nobody
    # accountable, so it does not count — require both halves.
    reviewed_ok=0
    if (reviewed != "") {
      has_anchor = (reviewed ~ /[0-9]{4}-[0-9]{2}-[0-9]{2}/ ||   # a date
                    reviewed ~ /#[0-9]+/ ||                      # an issue/PR ref
                    reviewed ~ /https?:\/\// ||                  # a URL
                    reviewed ~ /[0-9a-fA-F]{7,40}/)              # a commit sha
      # Strip the anchors; a reviewer component is a residual token with a
      # letter that is not merely a boolean word (a bare `reviewed: true` — even
      # alongside a date — names no reviewer).
      rest = reviewed
      gsub(/https?:\/\/[^[:space:]]+/, " ", rest)                # URLs out
      gsub(/[0-9]{4}-[0-9]{2}-[0-9]{2}/, " ", rest)              # dates out
      gsub(/#[0-9]+/, " ", rest)                                 # refs out
      gsub(/[0-9a-fA-F]{7,40}/, " ", rest)                       # shas out
      rlc = tolower(trim(rest))
      has_reviewer = (rest ~ /[A-Za-z]/ &&
                      rlc != "true" && rlc != "false" && rlc != "yes" && rlc != "no")
      if (has_anchor && has_reviewer) reviewed_ok=1
    }
    record = (reviewed_ok || reviewcontent)
    if (status != "accepted") {
      if (status == "") print "OK — no accepted status; no review record required"
      else printf "OK — status: %s; no review record required\n", status
      exit 0
    }
    if (record) { print "OK — accepted and carries a review record"; exit 0 }
    print "FAIL — status: accepted but no review record"
    print "       add a reviewed: <reviewer, date/ref> frontmatter key, or a non-empty ## Review section"
    exit 1
  }
' "$ARTIFACT"
