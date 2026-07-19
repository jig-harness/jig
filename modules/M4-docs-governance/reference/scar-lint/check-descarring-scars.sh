#!/usr/bin/env bash
# De-scarring lint — an approved doc must carry no review scars.
#
# A "scar" is a trace of the review that produced the doc: struck-through
# corrected text, resolution phrasing ("addressed", "good catch"), or a
# reviewer-dialogue/attribution line. Those belong in the review thread, the
# tracking issue, git/PR history, or a light `## Version history` section —
# never in the approved artifact (see ../../templates/WIKI-SCHEMA.md).
#
# Scope: only docs that are `status: approved` in their frontmatter are
# scanned; drafts are exempt (scars are fine while a doc is in flight). In CI,
# restrict the file list to the branch diff so the untouched approved corpus
# isn't swept every run — that selection is wiring, not this script's job.
#
# False-positive guards:
#   - fenced code blocks and inline `code` spans are masked before scanning, so
#     a doc that *documents* scar syntax (like this module's own docs) is not
#     flagged;
#   - phrase/attribution matches are anchored to list/quote-item openings, so
#     "addressed" only flags when it opens a bullet, never mid-prose;
#   - two opt-outs: a path allowlist ($ALLOWLIST) for docs whose subject IS the
#     review process, and a `descar_allow: true` frontmatter key
#     (frontmatter-only by design — an in-prose marker couldn't be told apart
#     from documentation of the marker).
#
# Conventions: exit 0 clean, 1 on a scar (fail-closed so the self-test is
# meaningful); CI may run it advisory (continue-on-error) while its precision
# is proven, then promote to blocking.
#
# Usage:
#   check-descarring-scars.sh docs/a.md docs/b.md
#   ALLOWLIST="docs/WIKI-SCHEMA.md docs/review/" check-descarring-scars.sh <files...>
#   DOCS_DIR=docs check-descarring-scars.sh      # no args: scan approved docs in the tree
set -u

DOCS_DIR="${DOCS_DIR:-docs}"
# Space-separated path substrings whose docs are exempt (their subject is review).
ALLOWLIST="${ALLOWLIST:-}"

fm_value() { # <file> <key> from leading frontmatter only
  awk -v k="$2" '
    NR==1 && $0 !~ /^---[[:space:]]*$/ { exit }
    /^---[[:space:]]*$/ { d++; if (d==2) exit; next }
    d==1 && $0 ~ "^"k":[[:space:]]" {
      v=$0; sub("^"k":[[:space:]]*","",v);
      sub(/^["\047]/,"",v); sub(/["\047][[:space:]]*$/,"",v); print v; exit }
  ' "$1"
}

allowed() { # path allowlisted?
  for pat in $ALLOWLIST; do case "$1" in *"$pat"*) return 0;; esac; done
  return 1
}

# Emit "lineno: content" for each scar in a file (code-masked, anchored).
scan_scars() {
  awk '
    { raw=$0 }
    /^[[:space:]]*(```|~~~)/ { infence = !infence; next }
    infence { next }
    {
      line=raw; gsub(/`[^`]*`/, "  ", line); low=tolower(line)
      if (line ~ /~~[^~]+~~/) { print NR": "raw; next }
      if (line ~ /^[[:space:]]*([-*>]|[0-9]+\.)[[:space:]]+/) {
        if (low ~ /(addressed|fixed as suggested|good catch|as per review|as requested|resolved per review|done as suggested)/) { print NR": "raw; next }
        if (low ~ /(reviewer|coderabbit|codex|copilot|shadow reviewer)[[:space:]]*:/) { print NR": "raw; next }
      }
    }
  ' "$1"
}

scars_found=0
check_file() {
  local file="$1" hits
  [ "$(fm_value "$file" status)" = "approved" ] || return 0   # drafts exempt
  [ "$(fm_value "$file" descar_allow)" = "true" ] && return 0
  allowed "$file" && return 0
  hits=$(scan_scars "$file")
  if [ -n "$hits" ]; then
    echo "SCAR $file"
    printf '%s\n' "$hits" | sed 's/^/  /'
    scars_found=$((scars_found+1))
  fi
}

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  IFS=$'\n' read -r -d '' -a files < <(find "$DOCS_DIR" -name '*.md' 2>/dev/null && printf '\0')
fi

for f in "${files[@]:-}"; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || { echo "ERROR: not a file: $f" >&2; exit 2; }
  check_file "$f"
done

if [ "$scars_found" -gt 0 ]; then
  echo ""
  echo "$scars_found approved doc(s) carry review scars — move them to the"
  echo "review thread / issue / a ## Version history section, or set"
  echo "descar_allow: true if the doc's subject is the review process."
  exit 1
fi
echo "OK — no scars in approved docs"
