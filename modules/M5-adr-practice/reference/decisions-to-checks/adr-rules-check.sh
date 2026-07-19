#!/usr/bin/env bash
# ADR rules checker — enforce pattern-checkable ADR decisions on changed code.
#
# A generic interpreter of an adr-rules.yaml catalog (see
# ../../templates/adr-rules.yaml). For each rule it applies one of two checks
# to each candidate file (skipping the rule's `exclude` globs):
#   - deny-on-match  (no `follow_check`): a line matching `pattern` is a
#                     violation — a forbidden construct.
#   - require-nearby (has `follow_check`): a line matching `pattern` is a
#                     violation UNLESS `follow_check` matches within the next
#                     few lines — a required companion is missing.
# Every violation names the ADR the rule derives from, so a failure points back
# to the decision.
#
# `critical` violations fail the check (exit 1); `warning`/`info` are reported
# but pass, unless STRICT=1 promotes everything to failing. This is the generic
# mechanism the reference implementation hand-codes per rule — here the rules
# live in data, not in the script.
#
# Portable: bash + awk + grep. No language runtime.
#
# Usage:
#   adr-rules-check.sh <file...>
#   RULES=path/to/adr-rules.yaml adr-rules-check.sh <file...>
#   STRICT=1 adr-rules-check.sh <file...>     # warnings fail too
set -u
RULES="${RULES:-.adr-rules.yaml}"
STRICT="${STRICT:-0}"
WINDOW="${WINDOW:-2}"   # lines after a match to look for follow_check

[ -f "$RULES" ] || { echo "ERROR: rules file not found: $RULES" >&2; exit 2; }
[ "$#" -gt 0 ] || { echo "OK — no files to check"; exit 0; }

# Field delimiter: US (unit separator, 0x1f) — non-whitespace, so empty middle
# fields survive `read` (a tab would collapse, being IFS-whitespace).
US=$'\037'

# Parse pattern_rules into US-delimited records:
#   id | severity | pattern | follow | exclude-csv | message
parse_rules() {
  awk -v s="$US" '
    function stripq(v){ sub(/^[^:]*:[[:space:]]*/,"",v); gsub(/^[\047"]|[\047"][[:space:]]*$/,"",v); return v }
    function arr(v){ sub(/^[^:]*:[[:space:]]*\[/,"",v); sub(/\][[:space:]]*$/,"",v); gsub(/[[:space:]]/,"",v); gsub(/[\047"]/,"",v); return v }
    function emit(){ print id s sev s pat s fol s exc s msg }
    /^pattern_rules:/ { inpr=1; next }
    inpr && /^[a-z_]/ { inpr=0 }
    inpr && /^[[:space:]]+-[[:space:]]*id:/ {
      if (have) emit()
      id=stripq($0); sev=""; pat=""; fol=""; exc=""; msg=""; have=1; next
    }
    inpr && have && /^[[:space:]]+severity:/     { sev=stripq($0) }
    inpr && have && /^[[:space:]]+pattern:/      { pat=stripq($0) }
    inpr && have && /^[[:space:]]+follow_check:/ { fol=stripq($0) }
    inpr && have && /^[[:space:]]+exclude:/      { exc=arr($0) }
    inpr && have && /^[[:space:]]+message:/      { msg=stripq($0) }
    END { if (have) emit() }
  ' "$RULES"
}

# Does path $1 match glob $2? Simple glob -> ERE: ** -> .*, * -> [^/]*, . -> \.
# Uses @ as the sed delimiter so the /  in [^/] doesn't collide.
glob_match() {
  local path="$1" glob="$2" re
  re=$(printf '%s' "$glob" | sed -e 's@[.]@\\.@g' -e 's@\*\*@\x01@g' -e 's@\*@[^/]*@g' -e 's@\x01@.*@g')
  printf '%s' "$path" | grep -qE "^${re}$"
}

critical=0
warns=0
report_violation() { # <sev> <adr-tagged-message> <file> <hits>
  local sev="$1" msg="$2" file="$3" hits="$4"
  echo "[$sev] $file — $msg"
  printf '%s\n' "$hits" | sed 's/^/    /'
  if [ "$sev" = "critical" ] || [ "$STRICT" = "1" ]; then critical=$((critical+1)); else warns=$((warns+1)); fi
}

while IFS="$US" read -r id sev pat fol exc msg; do
  [ -n "$pat" ] || continue
  for file in "$@"; do
    [ -f "$file" ] || continue
    # exclusions. set -f (noglob) so comma-split patterns like 'scripts/**'
    # aren't pathname-expanded against the working directory before matching.
    skip=0
    if [ -n "$exc" ]; then
      set -f; OLDIFS=$IFS; IFS=','
      for g in $exc; do
        if glob_match "$file" "$g"; then skip=1; break; fi
      done
      IFS=$OLDIFS; set +f
    fi
    [ "$skip" -eq 1 ] && continue

    if [ -z "$fol" ]; then
      # deny-on-match
      hits=$(grep -nE -- "$pat" "$file" 2>/dev/null || true)
      [ -n "$hits" ] && report_violation "${sev:-warning}" "$msg [$id]" "$file" "$hits"
    else
      # require-nearby. Patterns come in via the environment (not awk -v) so
      # awk does NOT strip the regex backslashes during assignment.
      hits=$(PAT="$pat" FOL="$fol" awk -v w="$WINDOW" '
        BEGIN { pat=ENVIRON["PAT"]; fol=ENVIRON["FOL"] }
        { lines[NR]=$0 }
        END {
          for (i=1;i<=NR;i++) if (lines[i] ~ pat) {
            ok=0; for (j=i;j<=i+w && j<=NR;j++) if (lines[j] ~ fol) { ok=1; break }
            if (!ok) print i": "lines[i]
          }
        }' "$file")
      [ -n "$hits" ] && report_violation "${sev:-warning}" "$msg [$id]" "$file" "$hits"
    fi
  done
done < <(parse_rules)

echo ""
if [ "$critical" -gt 0 ]; then
  suffix=""; [ "$warns" -gt 0 ] && suffix=", $warns warning(s)"
  echo "$critical blocking ADR-rule violation(s)$suffix."
  exit 1
fi
if [ "$warns" -gt 0 ]; then
  echo "$warns ADR-rule warning(s) (non-blocking; STRICT=1 to fail)."
fi
echo "OK — no blocking ADR-rule violations"
