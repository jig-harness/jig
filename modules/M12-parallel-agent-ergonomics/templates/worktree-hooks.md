# Worktree hooks

> Copyable, tool-independent skeletons for the two moments that bracket a
> parallel-agent session: **creating** a worktree (allocate and print its port
> slot) and **removing** one (nudge reflection). Wire them wherever your setup
> runs commands at those moments — see the mapping note at the bottom and the
> module `mappings.md` for concrete hook managers.

Both hooks assume the two reference scripts are reachable. Set one variable to
wherever you vendored the module and build paths from it:

```sh
# where you copied modules/M12-parallel-agent-ergonomics/ to
M12="${M12:-tools/worktree}"
```

## On create — allocate a port slot and print it

The moment a worktree is created, derive its deterministic port(s) and show them
so the agent (or human) knows exactly which ports this worktree owns. Deriving
means there is nothing to record or clean up.

```sh
#!/usr/bin/env bash
# worktree-create hook: print this worktree's deterministic port slot(s).
set -u
M12="${M12:-tools/worktree}"

id="$(git -C "$PWD" branch --show-current 2>/dev/null)"
[ -n "$id" ] || id="$(basename "$PWD")"    # detached HEAD: fall back to dir name

app_port="$(PORT_BASE=20000 PORT_SPAN=1000 bun "$M12/reference/port-allocator/allocate-port.ts" "$id")"
db_port="$( PORT_BASE=21000 PORT_SPAN=1000 bun "$M12/reference/port-allocator/allocate-port.ts" "$id")"

cat <<EOF
worktree "$id" port slots:
  app: $app_port
  db:  $db_port
Export these (or read them in your dev script), e.g.:
  export PORT=$app_port DB_PORT=$db_port
EOF
```

Wire it so the values reach the running processes — either export them from the
hook into a per-worktree env file the dev script sources, or have the dev script
call `allocate-port.ts` itself. Deterministic means either path yields the same
port.

## On remove — nudge reflection

When a worktree is torn down, the session is over and its lessons are freshest.
Print a short prompt to run the reflection step so those lessons enter the
learning loop instead of vanishing. Keep the prompt a **nudge**, not a blocker —
teardown should never fail because someone hasn't reflected. What may block it
is losing what was already captured: with Jig's
[`reflect`](https://github.com/jig-harness/jig/blob/main/plugin/skills/reflect/README.md)
skill, findings noted in this worktree's journal but not yet sent to the store
live in the worktree's git directory, which the removal deletes. The hook parks
them where the next reflection in any worktree of the repository picks them up,
and refuses the removal when it cannot.

The hook acts on the worktree it runs in: it names the worktree after its
working directory, and `journal.ts park` parks that worktree's journal. Run it
inside the worktree being removed, on the machine that holds it. A removal
wrapper resolves the target's path, changes into it, runs the hook, and
removes the worktree only when the hook succeeds; run from anywhere else, the
hook parks another worktree's journal and the target's findings are lost.

```sh
#!/usr/bin/env bash
# worktree-remove hook: nudge a reflection pass before the context is gone.
set -u
id="$(basename "$PWD")"

cat <<EOF
Tearing down worktree "$id".
Before the context is gone, capture what this session taught:
  • run your reflection step (with Jig's plugin: /jig:reflect), or
  • jot misses/surprises into your learning-loop inbox.
See the M8 learning loop for where that feedback goes.
EOF

# With Jig's reflect skill (JIG_REFLECT names its directory): keep the
# journal's unsent findings for the next reflection. Set JIG_REFLECT in every
# repository that uses the skill, even with reflection switched off: park
# still keeps findings noted while it was on. Leave it unset only where the
# skill is not used, so there is no journal to lose.
if [ -n "${JIG_REFLECT:-}" ]; then
  bun "$JIG_REFLECT/scripts/journal.ts" park || {
    echo "could not park this worktree's reflection findings; not removing it" >&2
    exit 1
  }
fi
# Otherwise exits 0 — a missing reflection must not block teardown.
```

The reflection destination and command are the **M8 learning loop**'s concern;
this hook only fires the reminder at the right moment and keeps what was
already captured.

## Where each manager wires these

The two hooks are ordinary scripts; only the wiring point differs per tool. The
module `mappings.md` gives the concrete locations — in brief:

| Manager | Create wiring | Remove wiring |
|---------|---------------|---------------|
| plain `git worktree` | a wrapper alias/script around `git worktree add` | a wrapper around `git worktree remove` |
| worktree-based agent runner | the runner's post-create / setup hook | the runner's pre-remove / teardown hook |
| direnv / per-dir env | `.envrc` calls `allocate-port.ts` on entry | n/a (no teardown event) |

Because ports are **derived**, the create hook is optional convenience: any dev
script can call `allocate-port.ts` directly and get the same answer without a
hook having run.
