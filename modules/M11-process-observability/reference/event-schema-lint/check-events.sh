#!/usr/bin/env bash
# Event-schema lint — process telemetry validated against its declared schema.
#
# A process-observability system is only as trustworthy as the events it emits.
# If a `review_completed` event ships without its `outcome`, or a typo'd
# `gate_reslt` type slips in, every metric built on it quietly lies. This gate
# validates a stream of emitted event records against the closed set of
# `event_types` declared in an event-schema (see ../../templates/event-schema.yaml):
#   * each event's `type` must be a REGISTERED event_type (an unknown type fails);
#   * every field the schema marks `required` for that type must be PRESENT and
#     NON-EMPTY (a missing or blank required field fails).
#
# Event stream format (portable, no jq): one event per line, whitespace-separated
# `key=value` tokens (logfmt-style). One token must be `type=<event_type>`. A
# value may itself contain `=` (only the first `=` splits key from value). Blank
# lines and `#` comment lines are ignored. Example:
#     type=review_completed pr=482 reviewer=shadow outcome=changes_requested findings=3 cost_unit=12
#
# Schema format: a `event_types:` block, each item two lines —
#     - type: review_completed
#       required: [pr, reviewer, outcome, findings, cost_unit]
# `required` is an inline flow list (`[]` for a type with no required fields).
#
# Portable: bash + awk. No yq / python / jq.
# Conventions (see ../../../M1-gates-enforcement-ladder/reference/grep-gate):
# exit 0 pass, 1 on a validation failure (unknown type / missing required field),
# 2 on a usage or format error (malformed schema, malformed event line).
# EVENTS via arg/env, SCHEMA via env so the self-test drives it with fixtures.
#
# Usage:
#   check-events.sh events.log
#   EVENTS=events.log SCHEMA=event-schema.yaml check-events.sh
set -u
EVENTS="${1:-${EVENTS:-}}"
SCHEMA="${SCHEMA:-event-schema.yaml}"

[ -n "$EVENTS" ] || { echo "ERROR: no events file given (arg or EVENTS=)" >&2; exit 2; }
[ -f "$EVENTS" ] || { echo "ERROR: events file not found: $EVENTS" >&2; exit 2; }
[ -f "$SCHEMA" ] || { echo "ERROR: schema not found: $SCHEMA" >&2; exit 2; }

awk -v schema="$SCHEMA" '
  function clean(v){
    sub(/^[^:]*:[[:space:]]*/,"",v)              # drop the key
    sub(/[[:space:]]+#.*$/,"",v)                 # drop a trailing inline comment
    gsub(/^[\047"]|[\047"][[:space:]]*$/,"",v)   # strip surrounding quotes
    gsub(/^[[:space:]]+|[[:space:]]+$/,"",v)     # trim
    return v
  }
  BEGIN {
    ntypes=0; schemabad=0
    # --- read the schema: build known[type] and req[type]="a b c" ---
    while ((getline line < schema) > 0) {
      if (line ~ /^event_types[[:space:]]*:/) { in_et=1; continue }
      # a new top-level key (unindented, not a list item) closes the block
      if (in_et && line ~ /^[^[:space:]#-]/) { in_et=0 }
      if (!in_et) continue
      if (line ~ /^[[:space:]]*-[[:space:]]*type[[:space:]]*:/) {
        curtype=clean(line)
        if (curtype=="") { print "ERROR: schema has an empty type value" > "/dev/stderr"; schemabad=1; continue }
        # A duplicate type would silently overwrite the earlier required list —
        # a schema that drops fields it appears to require. Reject it.
        if (curtype in known) { printf "ERROR: schema declares duplicate event type %s\n", curtype > "/dev/stderr"; schemabad=1; continue }
        known[curtype]=1; ntypes++; reqhas[curtype]=0
      }
      else if (line ~ /^[[:space:]]*required[[:space:]]*:/) {
        if (curtype=="") { print "ERROR: schema required: without a preceding type" > "/dev/stderr"; schemabad=1; continue }
        # A second required: for the same type would overwrite the first (e.g.
        # required: [artifact] then required: []), silently dropping fields.
        if (reqhas[curtype]) { printf "ERROR: schema type %s: duplicate required: list\n", curtype > "/dev/stderr"; schemabad=1; continue }
        r=line; sub(/^[^:]*:[[:space:]]*/,"",r); sub(/[[:space:]]+#.*$/,"",r)
        # required must be an inline flow list: [a, b, c] (or [])
        if (r !~ /^\[.*\]$/) {
          printf "ERROR: schema type %s: required must be a flow list [a, b]: %s\n", curtype, r > "/dev/stderr"
          # `continue` (not `next`): we are inside the schema-reading while-loop,
          # and `next` is invalid in a BEGIN action under gawk/mawk (POSIX awks)
          # — it fails the whole program at parse time. `continue` is both
          # portable and the correct "skip to the next schema line" here.
          schemabad=1; reqhas[curtype]=1; continue
        }
        gsub(/^\[|\]$/,"",r); gsub(/[[:space:]]+/,"",r)   # -> "a,b,c"
        req[curtype]=r; reqhas[curtype]=1
      }
    }
    close(schema)
    if (ntypes==0) { print "ERROR: schema declares no event_types" > "/dev/stderr"; schemabad=1 }
    for (t in known) if (!reqhas[t]) {
      printf "ERROR: schema type %s has no required: list\n", t > "/dev/stderr"; schemabad=1
    }
    fmterr=0; gatefail=0; nevents=0
  }
  schemabad { next }
  /^[[:space:]]*#/ { next }
  /^[[:space:]]*$/ { next }
  {
    delete present; etype=""; hastype=0; bad=0
    for (i=1;i<=NF;i++) {
      tok=$i; eq=index(tok,"=")
      if (eq < 2) {   # no "=", or empty key ("=v")
        printf "ERROR: malformed token %s (line %d): %s\n", tok, NR, $0 > "/dev/stderr"; fmterr=1; bad=1; break
      }
      k=substr(tok,1,eq-1); v=substr(tok,eq+1)
      present[k]=v
      if (k=="type") { etype=v; hastype=1 }
    }
    if (bad) next
    if (!hastype || etype=="") {
      printf "ERROR: event has no usable type= field (line %d): %s\n", NR, $0 > "/dev/stderr"; fmterr=1; next
    }
    nevents++
    if (!(etype in known)) {
      printf "line %d: unregistered event type \047%s\047\n", NR, etype; gatefail=1; next
    }
    n=split(req[etype], flds, ",")
    for (j=1;j<=n;j++) {
      f=flds[j]; if (f=="") continue
      if (!(f in present))        { printf "line %d: %s missing required field \047%s\047\n", NR, etype, f; gatefail=1 }
      else if (present[f]=="")    { printf "line %d: %s has empty required field \047%s\047\n", NR, etype, f; gatefail=1 }
    }
  }
  END {
    if (schemabad || fmterr) exit 2
    print ""
    if (nevents==0) { print "OK — no events to validate"; exit 0 }
    if (gatefail) { printf "Event-schema lint FAILED across %d event(s).\n", nevents; exit 1 }
    printf "OK — %d event(s) valid against the schema\n", nevents
    exit 0
  }
' "$EVENTS"
