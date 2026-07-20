#!/usr/bin/env bash
# Parity report — the learning loop's "measure" step, made mechanical.
#
# The flywheel keeps a lens only if it earns its place, and promotes a reviewer
# to blocking only when measured precision clears a bar (M7's promotion_bar).
# This gate turns a set of reviewer-vs-oracle tallies into those two decisions:
#   * missed_blockers  — a real blocker an oracle caught that the reviewer did
#                        NOT. Any such miss FAILS the gate: it is a regression
#                        signal (open a new lever) and a reason you cannot yet
#                        drop the oracle/vendor that caught it.
#   * precision        — of a reviewer's findings, the share that were real
#                        (TP / (TP + FP)). Reported per reviewer with a
#                        promotable? marker against MIN_PRECISION — this is the
#                        evidence M7 needs before flipping comment -> block.
#
# Input: a tallies file, one reviewer per line, whitespace-separated:
#     <reviewer> <true_positives> <false_positives> <missed_blockers>
# Blank lines and `# comments` are ignored. Produce it from your telemetry /
# weekly parity snapshot (see ../mappings.md).
#
# Portable: bash + awk. Conventions: exit 0 pass, 1 when a reviewer missed a
# blocker, 2 on a usage / format error. TALLIES via arg/env, MIN_PRECISION via
# env (default 0.90) so the self-test drives it with fixtures.
#
# Usage:
#   check-parity.sh parity.tsv
#   MIN_PRECISION=0.85 TALLIES=parity.tsv check-parity.sh
set -u
TALLIES="${1:-${TALLIES:-}}"
MIN_PRECISION="${MIN_PRECISION:-0.90}"

# A bad threshold silently corrupts every promotable? verdict (e.g. -1 promotes
# everyone), so reject anything outside a plain [0,1] decimal up front.
if ! [[ "$MIN_PRECISION" =~ ^(0([.][0-9]+)?|1([.]0+)?)$ ]]; then
  echo "ERROR: MIN_PRECISION must be a decimal in [0,1]: $MIN_PRECISION" >&2
  exit 2
fi

[ -n "$TALLIES" ] || { echo "ERROR: no tallies file given (arg or TALLIES=)" >&2; exit 2; }
[ -f "$TALLIES" ] || { echo "ERROR: tallies file not found: $TALLIES" >&2; exit 2; }

awk -v minp="$MIN_PRECISION" '
  function isnum(x){ return x ~ /^[0-9]+$/ }
  BEGIN { rc=0; n=0 }
  /^[[:space:]]*#/ { next }
  /^[[:space:]]*$/ { next }
  {
    rev=$1; tp=$2; fp=$3; miss=$4
    # exactly four fields: extra columns are schema drift, not a passing row.
    if (NF != 4 || rev=="" || !isnum(tp) || !isnum(fp) || !isnum(miss)) {
      printf "ERROR: bad row: %s\n", $0 > "/dev/stderr"; err=1; next
    }
    # one row per reviewer — a duplicate would double-count or silently shadow.
    if (rev in seen) {
      printf "ERROR: duplicate reviewer: %s\n", rev > "/dev/stderr"; err=1; next
    }
    seen[rev]=1
    n++
    denom = tp + fp
    if (denom > 0) { prec = tp/denom; ps=sprintf("%.2f", prec); promotable = (prec >= minp) ? "yes" : "no" }
    else           { ps="n/a";  promotable="no" }
    rdenom = tp + miss
    rs = (rdenom > 0) ? sprintf("%.2f", tp/rdenom) : "n/a"
    printf "%-14s TP=%-4s FP=%-4s missed=%-3s precision=%-5s recall=%-5s promotable=%s\n", \
           rev, tp, fp, miss, ps, rs, promotable
    if (miss+0 > 0) { rc=1; missedany=1 }
  }
  END {
    if (err) exit 2
    print ""
    if (n==0) { print "OK — no reviewers tallied (nothing to measure)"; exit 0 }
    if (missedany) {
      print "Parity gate FAILED — a reviewer missed a blocker an oracle caught (open a lever)."
      exit 1
    }
    printf "OK — no missed blockers; promotable? shown against MIN_PRECISION=%s\n", minp
    exit 0
  }
' "$TALLIES"
