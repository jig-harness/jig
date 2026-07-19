#!/usr/bin/env bash
# Frontmatter checker — validates docs frontmatter against a schema.
#
# Portable (bash + awk + coreutils; no yq/python). It reads the closed
# vocabularies out of a schema file of the shape in
# ../../templates/frontmatter-schema.yaml, so the schema stays the single
# source of truth. What it enforces per doc:
#   1. frontmatter present (opens with `---`, closes within the first 60 lines)
#   2. every required field present
#   3. `description` present for NEW docs (listed in $NEW_DOCS)
#   4. enum membership for type/status/lifecycle/owner, with a "did you mean"
#      hint pulled from the schema's suggestions map
#   5. `last_updated` is a strict YYYY-MM-DD date
#   6. tags is a bracketed list; each tag is in the canonical list; at most 8
#   7. ADR-specific fields when type == adr (decision_date + supersession)
#
# Conventions (see ../../../M1-gates-enforcement-ladder/reference/grep-gate):
# exit 0 on pass, 1 with a per-file report on failure; inputs via args/env so
# the paired self-test drives it with fixtures.
#
# Usage:
#   frontmatter-check.sh docs/foo.md docs/bar.md
#   SCHEMA=path/to/schema.yaml NEW_DOCS="docs/new.md" frontmatter-check.sh <files...>
#   DOCS_DIR=docs frontmatter-check.sh          # no args: scan the tree
set -u

SCHEMA="${SCHEMA:-docs/.frontmatter-schema.yaml}"
DOCS_DIR="${DOCS_DIR:-docs}"
NEW_DOCS="${NEW_DOCS:-}"

[ -f "$SCHEMA" ] || { echo "ERROR: schema not found: $SCHEMA" >&2; exit 2; }

# ---- schema readers (awk over the template's regular structure) ------------

# Enum values for a top-level key: the `values: [a, b, c]` array.
schema_values() {
  awk -v key="$1" '
    $0 ~ "^"key":[[:space:]]*$" { inb=1; next }
    inb && /^[a-z_]+:/ { inb=0 }
    inb && /^[[:space:]]+values:[[:space:]]*\[/ {
      l=$0; sub(/^[^[]*\[/,"",l); sub(/\].*/,"",l); gsub(/[[:space:]]/,"",l);
      gsub(/,/," ",l); print l; exit }
  ' "$SCHEMA"
}

# Suggestion "alias canonical" pairs under a key's `suggestions:` sub-block.
schema_suggest() {
  awk -v key="$1" '
    $0 ~ "^"key":[[:space:]]*$" { inb=1; next }
    inb && /^[a-z_]+:/ { inb=0 }
    inb && /^  suggestions:[[:space:]]*$/ { ins=1; next }
    inb && ins && /^  [a-z]/ { ins=0 }
    ins && /^    [^ ]/ {
      gsub(/"/,""); l=$0; sub(/^[[:space:]]+/,"",l); sub(/:[[:space:]]*/," ",l); print l }
  ' "$SCHEMA"
}

# Items of a top-level list: `key:` then `  - item` lines.
schema_list() {
  awk -v key="$1" '
    $0 ~ "^"key":[[:space:]]*$" { inb=1; next }
    inb && /^[a-z_]+:/ { inb=0 }
    inb && /^[[:space:]]+-[[:space:]]/ {
      v=$0; sub(/^[[:space:]]+-[[:space:]]*/,"",v); sub(/[[:space:]]*#.*/,"",v);
      gsub(/[[:space:]]/,"",v); if(v!="") print v }
  ' "$SCHEMA"
}

# ADR-specific required fields: type_specific: -> adr: -> list.
schema_adr_required() {
  awk '
    /^type_specific:[[:space:]]*$/ { int_=1; next }
    int_ && /^[a-z_]+:/ { int_=0; ina=0 }
    int_ && /^[[:space:]]+adr:[[:space:]]*$/ { ina=1; next }
    int_ && ina && /^  [a-z]/ && $0 !~ /^[[:space:]]+adr:/ { ina=0 }
    ina && /^[[:space:]]+-[[:space:]]/ {
      v=$0; sub(/^[[:space:]]+-[[:space:]]*/,"",v); sub(/[[:space:]]*#.*/,"",v);
      gsub(/[[:space:]]/,"",v); if(v!="") print v }
  ' "$SCHEMA"
}

REQUIRED=$(schema_list required)
REQUIRED_NEW=$(schema_list required_new)
ADR_REQUIRED=$(schema_adr_required)
TAGS_CANON=" $(schema_list tags | tr '\n' ' ') "

declare -A ENUM
for f in type status lifecycle owner; do
  ENUM[$f]=" $(schema_values "$f" | tr '\n' ' ') "
done

# ---- per-doc frontmatter reader -------------------------------------------

fm_value() { # <file> <key> -> value (quotes stripped), empty if absent
  awk -v k="$2" '
    NR==1 && $0 !~ /^---[[:space:]]*$/ { exit }
    /^---[[:space:]]*$/ { d++; if (d==2) exit; next }
    d==1 && $0 ~ "^"k":[[:space:]]" {
      v=$0; sub("^"k":[[:space:]]*","",v);
      sub(/^["\047]/,"",v); sub(/["\047][[:space:]]*$/,"",v);
      print v; exit }
  ' "$1"
}

is_new() { case " $NEW_DOCS " in *" $1 "*) return 0;; esac; return 1; }

suggest_for() { # <field> <badvalue> -> canonical hint or empty
  schema_suggest "$1" | awk -v bad="$2" '$1==bad {print $2; exit}'
}

# ---- validate one file -----------------------------------------------------

errors=0
check_file() {
  local file="$1" errs=() v tag n
  # 1. frontmatter present + closes within 60 lines
  if ! head -n1 "$file" | grep -q '^---[[:space:]]*$'; then
    errs+=("no frontmatter (must open with ---)")
  elif ! head -n60 "$file" | tail -n +2 | grep -q '^---[[:space:]]*$'; then
    errs+=("frontmatter not closed within first 60 lines")
  else
    # 2. required fields
    for req in $REQUIRED; do
      [ -n "$(fm_value "$file" "$req")" ] || errs+=("missing required field: $req")
    done
    # 3. description for new docs
    if is_new "$file"; then
      for req in $REQUIRED_NEW; do
        [ -n "$(fm_value "$file" "$req")" ] || errs+=("new doc missing required field: $req")
      done
    fi
    # 4. enum membership
    for field in type status lifecycle owner; do
      v=$(fm_value "$file" "$field"); [ -n "$v" ] || continue
      case "${ENUM[$field]}" in
        *" $v "*) : ;;
        *) hint=$(suggest_for "$field" "$v")
           if [ -n "$hint" ]; then errs+=("invalid $field '$v' (did you mean '$hint'?)")
           else errs+=("invalid $field '$v' (not in schema enum)"); fi ;;
      esac
    done
    # 5. last_updated format
    v=$(fm_value "$file" last_updated)
    if [ -n "$v" ] && ! printf '%s' "$v" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
      errs+=("last_updated '$v' is not YYYY-MM-DD")
    fi
    # 6. tags: bracketed list, canonical, <=8
    v=$(fm_value "$file" tags)
    if [ -n "$v" ]; then
      if ! printf '%s' "$v" | grep -qE '^\[.*\]$'; then
        errs+=("tags must be a bracketed list: [a, b]")
      else
        n=0
        set -f   # noglob: a tag token that is a shell glob metachar must not expand
        for tag in $(printf '%s' "$v" | sed -E 's/^\[|\]$//g; s/,/ /g'); do
          n=$((n+1))
          case "$TAGS_CANON" in *" $tag "*) : ;; *) errs+=("unknown tag '$tag' (not in canonical list; run the tag normalizer)");; esac
        done
        set +f
        [ "$n" -le 8 ] || errs+=("too many tags ($n > 8)")
      fi
    fi
    # 7. ADR-specific
    if [ "$(fm_value "$file" type)" = "adr" ]; then
      for req in $ADR_REQUIRED; do
        [ -n "$(fm_value "$file" "$req")" ] || errs+=("adr missing required field: $req")
      done
      v=$(fm_value "$file" decision_date)
      if [ -n "$v" ] && [ "$v" != "~" ] && ! printf '%s' "$v" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
        errs+=("decision_date '$v' is not YYYY-MM-DD")
      fi
    fi
  fi
  if [ "${#errs[@]}" -gt 0 ]; then
    echo "FAIL $file"
    for e in "${errs[@]}"; do echo "  - $e"; done
    errors=$((errors+1))
  fi
}

# ---- collect files ---------------------------------------------------------

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

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "$errors doc(s) failed frontmatter validation."
  exit 1
fi
echo "OK — frontmatter valid"
