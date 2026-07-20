#!/usr/bin/env bash
# No-dark-instruments — every declared metric must be actually wired.
#
# The hard-won lesson from the reference implementation: an instrument that is
# provisioned but fail-open (a metric on the dashboard whose source was never
# connected, an API key that was never set) is WORSE than none — it makes the
# "measure" step look done while the number is silently dark, so process
# decisions run on a gauge that reads zero because nothing feeds it. This gate
# reads a metrics registry (see ../../templates/metrics-registry.yaml) and FAILS
# if any metric's `source` (the wired event or query behind it) is missing,
# empty, or a placeholder — TODO / tbd / dark / none / fixme (case-insensitive) —
# i.e. a metric CLAIMED but not connected.
#
# Registry format: a `metrics:` block, each item a mapping with at least
#     - id: gate-pass-rate
#       source: query:gate_result_pass_ratio      # the wired event/query
#       owner: platform-team
# `source` is what this gate checks; a real registry also carries an `owner`.
#
# Portable: bash + awk. No yq / python / jq.
# Conventions: exit 0 pass, 1 when a metric is dark (unwired source), 2 on a
# usage / format error (no metrics collection, missing file).
# REGISTRY via arg/env so the self-test drives it with fixtures.
#
# Usage:
#   check-metrics-wired.sh metrics-registry.yaml
#   REGISTRY=metrics-registry.yaml check-metrics-wired.sh
set -u
REGISTRY="${1:-${REGISTRY:-metrics-registry.yaml}}"

[ -f "$REGISTRY" ] || { echo "ERROR: registry not found: $REGISTRY" >&2; exit 2; }

# Fail closed if the metrics collection is absent OR is not a collection at all.
# A registry that parses to zero metrics because its `metrics:` key is missing
# (or misspelled) must not read the same as a clean run; and a SCALAR value
# (`metrics: disabled`) is an invalid collection that would otherwise parse to
# zero and pass as "empty". Only an empty value (a block list follows) or an
# empty flow list `[]` is a legitimately-empty registry.
metrics_line=$(grep -E "^[\"']?metrics[\"']?[[:space:]]*:" "$REGISTRY" | head -1)
[ -n "$metrics_line" ] || { echo "ERROR: no 'metrics:' collection found in $REGISTRY (nothing to check)" >&2; exit 2; }
metrics_val=$(printf '%s' "$metrics_line" | sed -E 's/^[^:]*:[[:space:]]*//; s/[[:space:]]+#.*$//; s/[[:space:]]+$//')
case "$metrics_val" in
  ''|'[]') : ;;   # a block list follows, or an empty flow list — a real collection
  *) echo "ERROR: 'metrics:' must be a collection (a block list or []), not the scalar '$metrics_val' in $REGISTRY" >&2; exit 2 ;;
esac

US=$'\037'   # unit separator: survives an empty source field through `read`

# Parse the metrics block into US-delimited records: id | source
parse_metrics() {
  awk -v s="$US" '
    function clean(v){
      sub(/^[^:]*:[[:space:]]*/,"",v)              # drop the key
      sub(/[[:space:]]+#.*$/,"",v)                 # drop a trailing inline comment
      sub(/^#.*$/,"",v)                            # a value that is only a comment
      gsub(/^[\047"]|[\047"][[:space:]]*$/,"",v)   # strip surrounding quotes
      gsub(/^[[:space:]]+|[[:space:]]+$/,"",v)     # trim
      return v
    }
    function emit(){ if(have) print id s src }
    /^[\047"]?metrics[\047"]?[[:space:]]*:[[:space:]]*$/ { inm=1; next }
    inm && /^[^[:space:]#-]/ { emit(); inm=0; have=0 }        # a new top-level key closes the block
    inm && /^[[:space:]]*-[[:space:]]/ { emit(); id=""; src=""; havesrc=0; have=1 }
    inm && have && /^[[:space:]]*(-[[:space:]]+)?[\047"]?id[\047"]?[[:space:]]*:/     { id=clean($0) }
    inm && have && /^[[:space:]]*(-[[:space:]]+)?[\047"]?source[\047"]?[[:space:]]*:/ { src=clean($0); havesrc=1 }
    END { emit() }
  ' "$REGISTRY"
}

# Placeholder / empty source values that mean "not actually wired" — including
# the empty YAML collections `[]` and `{}` and the nulls `~` / `null`.
is_dark() {
  local v; v=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$v" in
    ""|"~"|"null"|"[]"|"{}"|"todo"|"tbd"|"dark"|"none"|"fixme") return 0 ;;
    *) return 1 ;;
  esac
}

errors=0
count=0
while IFS="$US" read -r id src; do
  count=$((count+1))
  label="${id:-"(metric #$count, no id)"}"
  if is_dark "$src"; then
    echo "DARK $label — source is '${src:-<unset>}' (not wired)"
    errors=$((errors+1))
  else
    echo "OK   $label — source: $src"
  fi
done < <(parse_metrics)

echo ""
if [ "$count" -eq 0 ]; then
  echo "OK — no metrics registered (empty registry)"
  exit 0
fi
if [ "$errors" -gt 0 ]; then
  echo "No-dark-instruments FAILED: $errors dark instrument(s) of $count metric(s)."
  exit 1
fi
echo "OK — all $count metric(s) wired to a real source"
