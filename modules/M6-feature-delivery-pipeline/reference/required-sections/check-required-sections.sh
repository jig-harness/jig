#!/usr/bin/env bash
# Required-sections gate — a stage artifact carries every REQUIRED heading.
#
# The feature pipeline's promise is that "each stage produces a NAMED artifact
# from a committed template" (a PRD, an architecture doc, a research note). A
# template is only real if the artifact actually keeps its required headings, so
# a downstream stage can rely on finding them. This gate reads a markdown
# artifact and a list of required section headings and fails if any is absent.
#
# Inputs:
#   * ARTIFACT  — the markdown file to check      (arg 1 or ARTIFACT env)
#   * the required headings, from EITHER:
#       - SECTIONS env — a list of heading labels, one per line or `|`-separated
#         (wins when set), OR
#       - a manifest file (arg 2 or MANIFEST env) — one heading label per line;
#         blank lines and `# comment` lines ignored.
#     Labels are plain heading text ("Success metrics"), not `## Success metrics`.
#
# Matching is forgiving (low false alarm): a required label matches any ATX
# heading (`#`..`######`) in the artifact whose text is equal after trimming
# whitespace, dropping the leading `#` markers, a trailing `:` and any closing
# `#`, and lowercasing. Headings inside fenced code blocks are ignored.
#
# Conventions: exit 0 all present, 1 a required heading missing, 2 usage/format
# error (no artifact, file not found, no required sections given).
#
# Usage:
#   check-required-sections.sh prd.md sections.txt
#   SECTIONS='Problem statement|Success metrics' check-required-sections.sh prd.md
#   ARTIFACT=prd.md MANIFEST=sections.txt check-required-sections.sh
set -u
ARTIFACT="${1:-${ARTIFACT:-}}"

[ -n "$ARTIFACT" ] || { echo "ERROR: no artifact file given (arg 1 or ARTIFACT=)" >&2; exit 2; }
[ -f "$ARTIFACT" ] || { echo "ERROR: artifact not found: $ARTIFACT" >&2; exit 2; }

# Assemble the raw list of required labels: SECTIONS env wins; else a manifest.
if [ -n "${SECTIONS:-}" ] && [ -n "$(printf '%s' "$SECTIONS" | tr -d '[:space:]|')" ]; then
  sections_raw="$SECTIONS"
else
  MANIFEST="${2:-${MANIFEST:-}}"
  [ -n "$MANIFEST" ] || { echo "ERROR: no required sections (set SECTIONS= or pass a manifest as arg 2 / MANIFEST=)" >&2; exit 2; }
  [ -f "$MANIFEST" ] || { echo "ERROR: manifest not found: $MANIFEST" >&2; exit 2; }
  sections_raw="$(cat "$MANIFEST")"
fi

# Normalized set of headings actually present in the artifact. Fence-aware, and
# it ignores headings that are not RENDERED sections: a leading YAML frontmatter
# block (whose block scalars can hold markdown-looking text) and anything inside
# an HTML comment (single- or multi-line).
artifact_headings="$(awk '
  NR==1 && /^---[[:space:]]*$/ { infm=1; next }         # enter frontmatter
  infm { if ($0 ~ /^---[[:space:]]*$/) infm=0; next }   # skip to its close
  {
    line = $0
    if (inhtml) {                                       # inside a multi-line comment
      if (line ~ /-->/) { sub(/^.*-->/, "", line); inhtml=0 } else next
    }
    gsub(/<!--.*-->/, "", line)                         # whole inline comment(s)
    if (line ~ /<!--/) { sub(/<!--.*$/, "", line); inhtml=1 }  # comment opens, runs on
    if (line ~ /^[[:space:]]*(```|~~~)/) { infence = !infence; next }
    if (infence) next
    # At most THREE leading spaces is a real ATX heading; 4+ spaces (or a tab) is
    # an indented code block, not a rendered section.
    if (line ~ /^ {0,3}#{1,6}[[:space:]]+/) {
      sub(/^ {0,3}#{1,6}[[:space:]]+/, "", line)        # strip the leading marker
      sub(/[[:space:]]*#+[[:space:]]*$/, "", line)      # strip a closing-ATX run
      sub(/[[:space:]]+$/, "", line)
      sub(/:[[:space:]]*$/, "", line)                   # strip a trailing colon
      sub(/[[:space:]]+$/, "", line)
      print tolower(line)
    }
  }
' "$ARTIFACT")"

missing=0 present=0 parsed=0
while IFS= read -r want; do
  case "$want" in ''|'#'*) continue ;; esac            # skip blanks / manifest comments
  w="$(printf '%s' "$want" \
        | sed -E 's/^[[:space:]]+//; s/[[:space:]]*#+[[:space:]]*$//; s/[[:space:]]*:?[[:space:]]*$//' \
        | tr '[:upper:]' '[:lower:]')"
  [ -n "$w" ] || continue
  parsed=$((parsed+1))
  if printf '%s\n' "$artifact_headings" | grep -Fxq -- "$w"; then
    present=$((present+1))
  else
    echo "MISSING required section: \"$(printf '%s' "$want" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')\""
    missing=$((missing+1))
  fi
done <<EOF
$(printf '%s' "$sections_raw" | tr '|' '\n')
EOF

[ "$parsed" -gt 0 ] || { echo "ERROR: no required section labels parsed (empty SECTIONS / manifest)" >&2; exit 2; }

if [ "$missing" -gt 0 ]; then
  echo ""
  echo "Required-sections gate FAILED for $ARTIFACT: $missing missing, $present present."
  exit 1
fi
echo "OK — all $present required sections present in $ARTIFACT"
