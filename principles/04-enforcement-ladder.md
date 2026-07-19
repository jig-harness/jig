# 4 — Enforcement-ladder discipline

Every rule lives on a rung of the **enforcement ladder**:

```
written convention → editor/local script → git hook → CI → mandatory review step
```

Each rung is progressively harder to bypass. The discipline is not "everything
must be CI-enforced" — it is that **every rule names its current rung and its
promotion path**, so "convention-only" is a tracked state rather than an
invisible default.

**Why.** Teams (and agents) systematically overestimate how enforced their
rules are. The gap between "we always do X" and "something fails if we don't"
is where regressions live. Naming the rung makes the gap visible; the auditor
scores it (*absent → convention-only → mechanically enforced*).

**Consequences:**

- Local hooks are conveniences; **CI is the authority** (hooks can be bypassed;
  CI closes the hole). The same check runs in both.
- Checks that auto-fix (formatters, regenerators) fix-and-stage at commit time
  instead of failing — reserve failure for what can't be auto-fixed.
- Every gate has an **escape hatch with an audit trail**: documented
  suppression tokens with justifications, never ad-hoc bypasses.
- Gates themselves are tested (a grep gate ships a self-test), and advisory
  gates carry a promotion plan ("blocking once the baseline is clean") —
  advisory-forever is drift.
- New rules start at the cheapest rung that works and are promoted on
  evidence, not enthusiasm.
