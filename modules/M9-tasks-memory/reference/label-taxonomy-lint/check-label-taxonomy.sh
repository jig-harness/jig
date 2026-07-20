#!/usr/bin/env bash
# Label-taxonomy lint — the tasks-&-memory invariant, made mechanical.
#
# A label taxonomy (see ../../templates/label-taxonomy.yaml) is the SSoT for how
# work is classified and, crucially, which process each flag label FIRES. This
# gate keeps that file honest so labels stay process triggers, not folksonomy.
# It checks a label-taxonomy.yaml:
#   1. every label `id:` (under types, statuses, or flags) is UNIQUE across the
#      whole file — a collision makes a label ambiguous.
#   2. `types:` and `statuses:` are CLOSED, NON-EMPTY lists — the mandatory
#      vocabulary every issue draws from (an absent or empty list classifies
#      nothing, so an issue could carry no type or no status at all).
#   3. every entry under `flags:` declares a NON-EMPTY `fires:` — a flag label
#      with no process trigger is folksonomy, which this module bans.
#   4. no UNKNOWN top-level keys (the schema is version/types/statuses/flags).
#
# Portable: bash + awk. No yq / python.
#
# Conventions (see ../../../M1-gates-enforcement-ladder/): exit 0 on pass, 1 on a
# violation (reported), 2 on a usage/format error. TAXONOMY via arg/env so the
# self-test can drive it with fixtures.
#
# Usage:
#   check-label-taxonomy.sh label-taxonomy.yaml
#   TAXONOMY=label-taxonomy.yaml check-label-taxonomy.sh
set -u
TAXONOMY="${1:-${TAXONOMY:-label-taxonomy.yaml}}"

[ -f "$TAXONOMY" ] || { echo "ERROR: taxonomy not found: $TAXONOMY" >&2; exit 2; }

US=$'\037'   # unit separator: survives empty middle fields through `read`

# Parse the file into US-delimited records. One per top-level key:
#   K | <name> | | |
# and one per label entry (a `- ` list item under a section):
#   E | <section> | <id> | <fires>
# A record starts at each list item, not at `- id:`, so a mis-ordered or
# id-less entry is still seen and reported, never silently dropped.
parse() {
  awk -v s="$US" '
    function stripq(v){
      sub(/^[^:]*:[[:space:]]*/,"",v)              # drop the key
      sub(/^#.*$/,"",v)                            # a value that is only a comment
      sub(/[[:space:]]+#.*$/,"",v)                 # drop a trailing inline comment
      gsub(/^[\047"]|[\047"][[:space:]]*$/,"",v)   # strip surrounding quotes
      gsub(/[[:space:]]+$/,"",v)                   # strip trailing whitespace
      return v
    }
    function emit(){ if(have) print "E" s section s id s fires s dup }
    # a top-level key (column 0) closes any open entry, records the key, and
    # sets the current section.
    /^[A-Za-z_][A-Za-z0-9_-]*[[:space:]]*:/ {
      emit(); have=0; id=""; fires=""; dup=""; nid=0; nfires=0
      k=$0; sub(/[[:space:]]*:.*/,"",k)
      print "K" s k s "" s "" s ""
      section=k
      next
    }
    # a new list item starts a label entry; the dash line may also carry a
    # field, so do not `next` — fall through to the field rules below.
    /^[[:space:]]*-[[:space:]]/ { emit(); have=1; id=""; fires=""; dup=""; nid=0; nfires=0 }
    have && /^[[:space:]]*(-[[:space:]]+)?id[[:space:]]*:/    { if(nid++) dup="id"; id=stripq($0) }
    have && /^[[:space:]]*(-[[:space:]]+)?fires[[:space:]]*:/ { if(nfires++) dup="fires"; fires=stripq($0) }
    END { emit() }
  ' "$TAXONOMY"
}

errors=0
declare -A SEEN
declare -A KEYS
declare -A COUNT
fail() { echo "  - $1"; errors=$((errors+1)); }
# Empty / null values, including the empty YAML collections `[]` and `{}`: a
# flag with `fires: []` carries no process trigger, so it is folksonomy.
is_empty() { case "$1" in ""|"~"|"null"|"[]"|"{}") return 0 ;; *) return 1 ;; esac }

ALLOWED=" version types statuses flags "

while IFS="$US" read -r kind f1 f2 f3 f4; do
  case "$kind" in
    K)
      key="$f1"
      # A duplicate top-level key last-wins in a YAML consumer: `types: [...]`
      # then `types: []` would leave no vocabulary while the first entry already
      # counted. Reject a repeat.
      if [ -n "${KEYS[$key]:-}" ]; then fail "duplicate top-level key '$key:'"; fi
      KEYS[$key]=1
      case "$ALLOWED" in
        *" $key "*) : ;;
        *) fail "unknown top-level key '$key:' (schema is version/types/statuses/flags)" ;;
      esac
      ;;
    E)
      section="$f1"; id="$f2"; fires="$f3"; dup="$f4"
      # A duplicate key within one entry last-wins (e.g. an empty `fires:` then
      # `fires: security-review` would pass the non-empty invariant) — reject.
      if [ -n "$dup" ]; then
        fail "a '$section' entry has a duplicate '$dup:' field"
        continue
      fi
      if [ -z "$id" ]; then
        fail "a '$section' entry has no id"
        continue
      fi
      # global uniqueness — one label id may not appear twice anywhere.
      if [ -n "${SEEN[$id]:-}" ]; then fail "duplicate label id '$id'"; else SEEN[$id]=1; fi
      COUNT[$section]=$(( ${COUNT[$section]:-0} + 1 ))
      # a flag with no trigger is folksonomy — the one thing this module bans.
      if [ "$section" = flags ] && is_empty "$fires"; then
        fail "flag '$id' declares no 'fires:' (a flag label with no process trigger is folksonomy)"
      fi
      ;;
  esac
done < <(parse)

# types / statuses must exist AND be non-empty closed lists.
for req in types statuses; do
  if [ -z "${KEYS[$req]:-}" ]; then
    fail "missing required top-level key '$req:'"
  elif [ "${COUNT[$req]:-0}" -eq 0 ]; then
    fail "'$req:' is empty (must be a closed, non-empty list)"
  fi
done

echo ""
if [ "$errors" -gt 0 ]; then
  echo "Label-taxonomy lint FAILED: $errors problem(s) in $TAXONOMY"
  exit 1
fi
echo "OK — labels valid (types=${COUNT[types]:-0}, statuses=${COUNT[statuses]:-0}, flags=${COUNT[flags]:-0})"
