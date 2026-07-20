#!/usr/bin/env bash
# Required-phases gate — a phase formula's REQUIRED gates, made mechanical.
#
# A phase formula (see ../../templates/phase-formula.yaml) declares the phases a
# class of recurring multi-phase work must pass, marking some `required: true`.
# This gate refuses to let a work item be CLOSED with a required phase skipped —
# the same "validate-then-gate" shape as M8's corpus (you may not claim done
# until the required step is on record).
#
# Two inputs:
#   RECORD  ($1 or RECORD=) — a work-item phase record: a `status: <value>` line
#            plus the completed phase ids, one per line. Blank lines and `#`
#            comments are ignored; a `phase:` prefix or a leading `- ` is fine.
#   FORMULA ($2 or FORMULA=, default `phase-formula.yaml` beside the record) —
#            the formula declaring which phases are `required: true`.
#
# If the item's status is a DONE state (DONE_STATES, default "done closed
# merged"), every required phase must appear in the record; a missing one FAILS.
# A non-done item passes — it is not yet claiming completion, so there is
# nothing to gate.
#
# Portable: bash + awk. No yq / python.
#
# Conventions (see ../../../M1-gates-enforcement-ladder/): exit 0 on pass, 1 when
# a required phase is skipped at close, 2 on a usage/format error. Inputs via
# arg/env so the self-test can drive fixtures.
#
# Usage:
#   check-formula.sh record.txt phase-formula.yaml
#   RECORD=record.txt FORMULA=phase-formula.yaml check-formula.sh
set -u
RECORD="${1:-${RECORD:-}}"
FORMULA="${2:-${FORMULA:-}}"
DONE_STATES="${DONE_STATES:-done closed merged}"

[ -n "$RECORD" ] || { echo "ERROR: no phase record given (arg or RECORD=)" >&2; exit 2; }
[ -f "$RECORD" ] || { echo "ERROR: phase record not found: $RECORD" >&2; exit 2; }
[ -n "$FORMULA" ] || FORMULA="$(dirname "$RECORD")/phase-formula.yaml"
[ -f "$FORMULA" ] || { echo "ERROR: phase formula not found: $FORMULA" >&2; exit 2; }

US=$'\037'

# --- 1. formula -> the set of REQUIRED phase ids --------------------------
# Emit `id | required` per phase entry under `phases:`.
parse_formula() {
  awk -v s="$US" '
    function stripq(v){
      sub(/^[^:]*:[[:space:]]*/,"",v)
      sub(/^#.*$/,"",v)
      sub(/[[:space:]]+#.*$/,"",v)
      gsub(/^[\047"]|[\047"][[:space:]]*$/,"",v)
      gsub(/[[:space:]]+$/,"",v)
      return v
    }
    function emit(){ if(have) print id s req s dup }
    /^[A-Za-z_][A-Za-z0-9_-]*[[:space:]]*:/ {
      emit(); have=0; id=""; req=""; dup=""; nid=0; nreq=0
      inphases = ($0 ~ /^phases[[:space:]]*:/)
      next
    }
    inphases && /^[[:space:]]*-[[:space:]]/ { emit(); have=1; id=""; req=""; dup=""; nid=0; nreq=0 }
    inphases && have && /^[[:space:]]*(-[[:space:]]+)?id[[:space:]]*:/       { if(nid++) dup="id"; id=stripq($0) }
    inphases && have && /^[[:space:]]*(-[[:space:]]+)?required[[:space:]]*:/  { if(nreq++) dup="required"; req=stripq($0) }
    END { emit() }
  ' "$FORMULA"
}

required_phases=""
phase_count=0
while IFS="$US" read -r id req dup; do
  phase_count=$((phase_count+1))
  # A duplicate key within one phase entry last-wins (e.g. required: true then
  # required: false drops a mandatory phase) — reject it.
  if [ -n "$dup" ]; then
    echo "ERROR: a phase entry in $FORMULA has a duplicate '$dup:' field" >&2; exit 2
  fi
  if [ -z "$id" ]; then
    echo "ERROR: a phase entry in $FORMULA has no id" >&2; exit 2
  fi
  req_lc=$(printf '%s' "$req" | tr '[:upper:]' '[:lower:]')
  case "$req_lc" in
    true|yes|on)      required_phases="$required_phases $id " ;;
    ''|false|no|off)  : ;;
    *) echo "ERROR: phase '$id' has a non-boolean required: '$req'" >&2; exit 2 ;;
  esac
done < <(parse_formula)

if [ "$phase_count" -eq 0 ]; then
  echo "ERROR: no phases declared in $FORMULA" >&2; exit 2
fi

# --- 2. record -> status + the set of completed phases --------------------
status=""
have_status=0
completed=" "
ltrim() { printf '%s' "${1#"${1%%[![:space:]]*}"}"; }
rtrim() { printf '%s' "${1%"${1##*[![:space:]]}"}"; }

while IFS= read -r raw || [ -n "$raw" ]; do
  line=$(rtrim "$(ltrim "$raw")")
  [ -z "$line" ] && continue
  case "$line" in \#*) continue ;; esac
  line="${line%%#*}"                       # strip a trailing inline comment
  line=$(rtrim "$line")
  [ -z "$line" ] && continue

  key=$(rtrim "${line%%:*}")
  if [ "$key" = status ] && [ "$line" != "$key" ]; then
    # A duplicate status would silently last-win: `status: closed` then
    # `status: open` could mask a terminal item (a concatenated/duplicated
    # export bypassing the gate). Exactly one status line is allowed.
    if [ "$have_status" -eq 1 ]; then
      echo "ERROR: duplicate 'status:' line in record $RECORD" >&2; exit 2
    fi
    status=$(ltrim "${line#*:}")
    # Strip a surrounding quote pair: a tracker export writes `status: "closed"`
    # as a normal quoted scalar, and the quotes must not make a terminal status
    # look non-terminal (which would silently skip the closure gate).
    case "$status" in
      \"*\") status="${status#\"}"; status="${status%\"}" ;;
      \'*\') status="${status#\'}"; status="${status%\'}" ;;
    esac
    status=$(rtrim "$(ltrim "$status")")
    have_status=1
    continue
  fi

  ph="${line#- }"                          # optional list dash
  pk=$(rtrim "${ph%%:*}")
  if [ "$pk" = phase ] && [ "$ph" != "$pk" ]; then
    ph=$(ltrim "${ph#*:}")                 # optional `phase:` prefix
  fi
  ph=$(rtrim "$ph")
  [ -n "$ph" ] && completed="$completed$ph "
done < "$RECORD"

if [ "$have_status" -eq 0 ]; then
  echo "ERROR: no 'status:' line in record $RECORD" >&2; exit 2
fi

# --- 3. gate: a DONE item must have recorded every required phase ---------
status_lc=$(printf '%s' "$status" | tr '[:upper:]' '[:lower:]')
is_done=0
for d in $DONE_STATES; do [ "$status_lc" = "$d" ] && is_done=1; done

if [ "$is_done" -eq 0 ]; then
  echo "OK — item status '$status' is not a done state; required-phase gate not yet applicable"
  exit 0
fi

missing=""
for p in $required_phases; do
  case "$completed" in
    *" $p "*) : ;;
    *) missing="$missing $p" ;;
  esac
done

if [ -n "$missing" ]; then
  echo "Required-phases gate FAILED — item is '$status' but a required phase is not recorded complete:"
  for p in $missing; do echo "  - $p"; done
  exit 1
fi
echo "OK — item is '$status' and every required phase is recorded complete"
