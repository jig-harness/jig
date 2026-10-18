# HITL decision registry

> TEMPLATE — copy to your repo (e.g. `docs/development/hitl-decision-registry.md`)
> and prune to the decisions your project actually makes. This is the single
> list of decision classes that must stay **human-in-the-loop
> ([HITL](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md))** — made by a person, never autonomously by an
> agent — and *why*. It exists so an autonomous run knows exactly where to
> stop, instead of that boundary living scattered across skill bodies, draft-PR
> rules, and habit. Shared with [M0](https://github.com/jig-harness/jig/tree/main/modules/M0-instruction-architecture)
> (instruction architecture) and referenced by
> [M7](https://github.com/jig-harness/jig/tree/main/modules/M7-pr-lifecycle-review) (PR lifecycle).

## How this registry is enforced

Two mechanisms back it, so it is more than prose:

- A **`hitl` label** on a tracked work item revokes **autonomous merge of the
  pull request that closes it**. The issue→PR link is the forge's closing
  reference (a `Closes #123` / `Fixes #123` line, or a PR linked to the issue);
  the agent may do the work and open/update the PR, but a **human** must perform
  the merge. Enforcement is the forge's branch-protection rule that requires a
  human actor to merge (no bot- or self-merge) — the same rule
  [M7](https://github.com/jig-harness/jig/tree/main/modules/M7-pr-lifecycle-review) relies on — so the label is mechanical,
  not advisory.
- The **decision points below** are wired into the relevant gate or skill (a
  merge requires a human actor; a dark-dial flip requires a recorded approval).

Convention-only entries are marked so — a tracked state, not a resting place.

## The registry

| Decision class | Why it must stay human | Trigger / where it bites |
|----------------|------------------------|--------------------------|
| Mark a PR **Ready** for review | Signals "worth a human's time"; only the author can judge readiness. A repository may delegate it to an unattended review driver, which marks Ready after the review round, or at the convergence, the repository declares; record that choice here | Draft→Ready transition |
| **Merge** a PR | The irreversible act; the point accountability attaches to | Merge button / branch protection requiring a human actor |
| **Release / promote to production** | Blast radius; needs a human owning the go/no-go | Deploy-promotion step (see [M10](https://github.com/jig-harness/jig/tree/main/modules/M10-environments-deploy)) |
| **Expand a PR's scope** | Silent scope creep hides risk and defeats review | Resolve-comments loop, when a fix reaches outside stated scope |
| **Overrule a human review thread** | An agent may not reject a person's concern on its own judgment | Resolve-comments loop, human-authored threads |
| **Promote an automated reviewer to blocking** | Giving a bot veto power is a policy change, gated on measured precision | Review-config `posture: comment → blocking` (see [M8](https://github.com/jig-harness/jig/tree/main/modules/M8-learning-loop)) |
| **Pick the next item** from the computed ranking | The ranking is a proposal computed from the tracker; choosing what to work next spends the team's attention and sets its direction, and an agent that picks its own next work also decides what nobody looks at | The post-merge stage's next-step pick ([`PR-LIFECYCLE.md`](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/templates/PR-LIFECYCLE.md), step 6) |
| **Reopen on a rejecting verdict, or waive a missing acceptance review** | A reopened item re-spends review effort; a waiver stands in for a review nobody ran. Both are judgments about whether the designed scope was delivered, and the pass that found the gap cannot be the one to excuse it: the approver is someone other than whoever runs the post-merge pass or the epic-closing step that found the gap | The epic-closing step and the post-merge stage (see [M9](https://github.com/jig-harness/jig/tree/main/modules/M9-tasks-memory)); the tracker transition that reopens or closes |
| **Flip a dark-by-default dial** | Enabling something previously off changes behavior for everyone | Any feature/gate flag default change |
| **Change the meta-spec / scaffolding** | Changing the rules the agents follow is self-modifying; needs approval | Reflection → scaffolding change (see [M8](https://github.com/jig-harness/jig/tree/main/modules/M8-learning-loop)) |
| **Destructive operations** | Data loss / history rewrite is unrecoverable | Force-push to shared branches, drops, history rewrites |
| **Legal / DPO sign-off** | Privacy, regulatory, and data-use decisions need accountable human approval | Privacy-impact, data-processing, or regulated-release checkpoint |
| **Customer-facing copy** | Public claims and user-visible behavior need human approval | Release notes, UI, docs, or support-copy publication |

## Adding an entry

A new HITL entry is itself worth an [ADR](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) when it changes
what agents may do autonomously. State the decision class, the one-line *why*,
and the concrete trigger — an entry with no trigger is unenforceable and
becomes decoration.
