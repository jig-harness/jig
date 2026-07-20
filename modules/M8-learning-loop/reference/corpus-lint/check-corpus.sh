#!/usr/bin/env bash
# Corpus-lint — the learning loop's invariants, made mechanical.
#
# The eval corpus (see ../../templates/corpus.yaml) is only as trustworthy as
# its discipline. This gate enforces the invariants that keep it honest, so the
# regression corpus never quietly lies about what it proves. Per fixture:
#   1. lever id is `L-NNNN` and UNIQUE across the corpus (parallel authors pick
#      the same next number exactly as with ADRs — guard it the same way).
#   2. category is a member of the miss taxonomy (a typo'd category hides a miss
#      from every count).
#   3. pinned_commit is present (a fixture with nothing pinned tests nothing).
#   4. lens is present (every filed miss is answered by an additive lens).
#   5. required: true  =>  a validated record with a date. This is the
#      validate-then-gate rule: a fixture may not enter the BLOCKING corpus
#      until a live run proved the reviewer now catches it.
#
# Portable: bash + awk. No yq / python.
#
# Conventions (see ../../../M1-gates-enforcement-ladder/reference/grep-gate):
# exit 0 on pass, 1 on a violation (per-fixture report), 2 on a usage error.
# CORPUS + TAXONOMY via env/arg so the self-test drives it with fixtures.
#
# Usage:
#   check-corpus.sh corpus.yaml
#   CORPUS=corpus.yaml TAXONOMY=miss-taxonomy.yaml check-corpus.sh
set -u
CORPUS="${1:-${CORPUS:-corpus.yaml}}"
TAXONOMY="${TAXONOMY:-$(dirname "$CORPUS")/miss-taxonomy.yaml}"

[ -f "$CORPUS" ]   || { echo "ERROR: corpus not found: $CORPUS" >&2; exit 2; }
[ -f "$TAXONOMY" ] || { echo "ERROR: taxonomy not found: $TAXONOMY" >&2; exit 2; }

# Fail closed if the fixtures collection is absent: a corpus that parses to zero
# fixtures because its `fixtures:` key is missing (or misspelled) must not read
# the same as a clean run. A key present but empty is a legitimate empty corpus.
grep -Eq "^[\"']?fixtures[\"']?[[:space:]]*:" "$CORPUS" \
  || { echo "ERROR: no 'fixtures:' collection found in $CORPUS (nothing to validate)" >&2; exit 2; }

US=$'\037'   # unit separator: survives empty middle fields through `read`

# Valid category ids: `- id: xxx` lines under the taxonomy's `categories:`.
taxonomy_ids() {
  awk '
    /^categories:[[:space:]]*$/ { inc=1; next }
    inc && /^[a-z_]+:/ { inc=0 }
    inc && /^[[:space:]]*-[[:space:]]*id:/ {
      v=$0; sub(/^[^:]*:[[:space:]]*/,"",v); gsub(/[[:space:]]/,"",v); print v }
  ' "$TAXONOMY"
}
CATS=" $(taxonomy_ids | tr '\n' ' ') "

# Parse fixtures into US-delimited records:
#   lever | category | pinned | lens | required | has_validated | has_date
# A record starts at each list item (`- ...`), not at `- lever:` — YAML does
# not require `lever` to come first, and a fixture with no lever at all must be
# reported (missing lever), never silently dropped.
parse_fixtures() {
  awk -v s="$US" '
    function stripq(v){
      sub(/^[^:]*:[[:space:]]*/,"",v)              # drop the key
      sub(/^#.*$/,"",v)                            # a value that is only a comment
      sub(/[[:space:]]+#.*$/,"",v)                 # drop a trailing inline comment
      gsub(/^[\047"]|[\047"][[:space:]]*$/,"",v)   # strip surrounding quotes
      gsub(/[[:space:]]+$/,"",v)                   # strip trailing whitespace
      return v
    }
    function isempty(v){ return v=="" || v=="~" || v=="null" || v=="{}" }
    function indent(l,   n){ n=0; while (substr(l,n+1,1)==" ") n++; return n }
    function emit(){ if(have) print lev s cat s pin s len s req s val s dat }
    /^[\047"]?fixtures[\047"]?[[:space:]]*:[[:space:]]*$/ { infx=1; next }
    infx && /^[\047"]?[a-zA-Z_]/ { emit(); infx=0; have=0 }
    # a new list item starts a record; the dash line may also carry a field, so
    # do not `next` — fall through to the field rules below.
    infx && /^[[:space:]]*-[[:space:]]/ {
      emit(); lev=""; cat=""; pin=""; len=""; req=""; val=0; dat=0
      have=1; invld=0; vindent=-1
    }
    # a line back at (or above) the "validated:" indent ends its nested block
    infx && have && invld && indent($0) <= vindent { invld=0 }
    # keys may be quoted (`"required": true` is the same YAML mapping key), so
    # accept an optional surrounding quote before matching on the key name.
    infx && have && /^[[:space:]]*(-[[:space:]]+)?[\047"]?lever[\047"]?[[:space:]]*:/         { lev=stripq($0) }
    infx && have && /^[[:space:]]*(-[[:space:]]+)?[\047"]?category[\047"]?[[:space:]]*:/      { cat=stripq($0) }
    infx && have && /^[[:space:]]*(-[[:space:]]+)?[\047"]?pinned_commit[\047"]?[[:space:]]*:/ { pin=stripq($0) }
    infx && have && /^[[:space:]]*(-[[:space:]]+)?[\047"]?lens[\047"]?[[:space:]]*:/          { len=stripq($0) }
    infx && have && /^[[:space:]]*(-[[:space:]]+)?[\047"]?required[\047"]?[[:space:]]*:/      { req=stripq($0) }
    # `validated:` with an inline value: only a real, non-empty value counts.
    infx && have && /^[[:space:]]*(-[[:space:]]+)?[\047"]?validated[\047"]?[[:space:]]*:[[:space:]]*[^[:space:]]/ {
      v=stripq($0); if (!isempty(v)) val=1; next
    }
    # `validated:` opening a nested block: only its nested `date:` counts.
    infx && have && /^[[:space:]]*(-[[:space:]]+)?[\047"]?validated[\047"]?[[:space:]]*:[[:space:]]*$/ { invld=1; vindent=indent($0); next }
    infx && have && invld && /^[[:space:]]+[\047"]?date[\047"]?[[:space:]]*:/ {
      d=stripq($0); if (!isempty(d)) { dat=1; val=1 }
    }
    END { emit() }
  ' "$CORPUS"
}

# YAML empty values (blank, `~`, `null`, `{}`) count as a missing field.
is_missing() { case "$1" in ""|"~"|"null"|"{}") return 0 ;; *) return 1 ;; esac }

errors=0
count=0
declare -A SEEN
fail() { echo "  - $1"; errors=$((errors+1)); }

while IFS="$US" read -r lever cat pin lens req val dat; do
  count=$((count+1))
  # 1. lever present, well-formed, and UNIQUE. A fixture with no lever is a
  #    real fixture missing a required field, not something to skip.
  if [ -z "$lever" ]; then
    echo "FIX (no lever)"
    fail "fixture has no lever id (a record must start with a lever)"
    continue
  fi
  echo "FIX $lever"
  case "$lever" in
    L-[0-9][0-9][0-9][0-9]) : ;;
    *) fail "lever '$lever' is not L-NNNN" ;;
  esac
  if [ -n "${SEEN[$lever]:-}" ]; then fail "duplicate lever id '$lever'"; else SEEN[$lever]=1; fi
  # 2. category membership
  if [ -z "$cat" ]; then fail "missing category"
  else case "$CATS" in *" $cat "*) : ;; *) fail "category '$cat' not in the taxonomy" ;; esac
  fi
  # 3. pinned commit present
  ! is_missing "$pin"  || fail "missing pinned_commit (pin the PRE-fix commit)"
  # 4. lens present
  ! is_missing "$lens" || fail "missing lens (every miss gets an additive lens)"
  # 5. validate-then-gate. Normalize the YAML boolean first: `True`/`TRUE`/`yes`
  #    are all truthy and must not dodge the rule by spelling; an unrecognized
  #    value is rejected rather than silently treated as not-required.
  req_lc=$(printf '%s' "$req" | tr '[:upper:]' '[:lower:]')
  case "$req_lc" in
    true|yes|on)      required=1 ;;
    ''|false|no|off)  required=0 ;;
    *) fail "required: '$req' is not a recognized boolean (use true/false)"; required=0 ;;
  esac
  if [ "$required" = 1 ]; then
    [ "$val" = "1" ] || fail "required: true but no validated record (validate before gating)"
    [ "$dat" = "1" ] || fail "validated record has no date"
  fi
done < <(parse_fixtures)

echo ""
if [ "$errors" -gt 0 ]; then
  echo "Corpus-lint FAILED: $errors problem(s) across $count fixture(s)."
  exit 1
fi
echo "OK — $count corpus fixture(s) valid"
