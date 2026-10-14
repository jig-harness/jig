# Promote-safety lint

A gate for the one wiring rule a production-deploy workflow has to keep:
**deploy only the verified artifact, and only on a human's say-so.** It scans a
workflows directory and fails a production deploy that fires itself, ships
something other than the `verified` pointer, or looks its commit up again by
name instead of shipping the one the gate approved.

## Why it exists

The delivery architecture (see [`../../templates/CI-ARCHITECTURE.md`](../../templates/CI-ARCHITECTURE.md))
ends in a **manual, gated promotion** of the **verified** artifact to
production. These workflow mistakes break that promise quietly:

- **(a) it auto-fires.** A production deploy triggered on a branch push with no
  manual gate means every merge ships to users — a bad merge reaches production
  before anyone looks. Promotion is supposed to be a deliberate human act.
- **(b) it ships a mutable ref.** A production deploy that checks out a moving
  branch (`main`), `HEAD`, or an `:latest` image tag ships *whatever the branch
  happens to be*, not the commit that actually passed verification — so "we only
  deploy verified artifacts" silently stops being true.
- **(c) it looks the commit up again.** A promotion is several jobs: a gate
  checks a commit, later jobs migrate, deploy and verify. If a later job
  fetches a branch by name, even the `verified` pointer, it gets whatever the
  name points at *when that job starts*. The pointer may have advanced while
  the gate ran or while the run waited its turn, so the job ships a commit the
  gate never checked. The gated commit is the shipped commit only when the
  gate outputs it and every later job takes it from that output.

This lint makes each of these regressions loud.

## Mechanism

**Scope to the production-deploy job.** A workflow has many jobs; the checks
apply to the job that *clearly* deploys to production — one whose lines carry
**both** a deploy signal (the word `deploy`) **and** a production signal
(`prod` / `production`). The lint segments the workflow into jobs (GitHub
Actions `jobs:` children; GitLab top-level jobs) and evaluates each
production-deploy job on its own, so a gate or a `verified` reference on some
*other* job — a preview deploy with its own `environment:`, a build job that
checks out the verified ref — can't mask an unsafe production job. Build, test,
and preview jobs lack the deploy+prod pair and are ignored. Detection runs
against a **comment-stripped** view, so a `#` comment mentioning (say)
`workflow_dispatch` can't fake a gate that isn't wired. A `#` inside a quoted
string is not a comment, so quoted text cannot hide the command after it.

A production-deploy **job** is flagged when **either** holds:

| # | Trips when | Safe alternative |
|---|-----------|------------------|
| (a) | it fires on `push` — a GitHub `on: push` (bare/quoted scalar, flow sequence, `- push` block sequence, block, or inline mapping), or a GitLab push rule (`$CI_PIPELINE_SOURCE == "push"` / legacy `only: pushes`, **including a job-level rule**) — **and** that job has no gate: no **job-level** `environment:` key, no GitLab `when: manual` | gate the deploy job behind a protected job-level `environment:`, GitLab `when: manual`, or trigger **only** via `workflow_dispatch` (no `push`) |
| (b) | the job selects a mutable ref **at all** — a `ref:` or a `--ref` flag of `main`/`master`/`develop`/`HEAD`, a `github.ref`/`github.ref_name`, or an `@latest`/`:latest` tag | deploy **only** the `verified` pointer/artifact and do not select a mutable ref in the deploy job (`ref: refs/tags/verified` / `--ref refs/tags/verified`, or download the `verified-*` artifact) |
| (c) | the job selects its commit **by name** — a `ref:` or `--ref` naming a branch (a literal such as `release`, or an expression whose last part is `ref`, `ref_name`, `head_ref`, `base_ref`, `branch` or `head_branch`, such as `inputs.branch`), or a run step's `git fetch`/`pull`/`checkout`/`switch`/`reset`/`merge`/`rebase`/`rev-parse` of a name; the `verified` pointer counts as a name in a job that has an upstream job, and when resolved a second time in the first job | the first job resolves the pointer once and outputs the commit (`outputs: { sha: … }`); every later job uses `${{ needs.<job>.outputs.<sha> }}` (GitLab: a variable passed on through a dotenv file of `NAME=value` lines, such as `"$GATED_SHA"`) |

A safe production deploy gates the push behind a protected environment (or
triggers only manually), ships only the verified pointer, and passes the gated
commit from job to job, so it trips none. Rule (c) does not read these as a
name: an upstream job's output, a shell variable (`$SHA`, `"${SHA}"`), a
command substitution (`$(cat gated-sha)`), a full or short commit hash, the
local `HEAD`, `FETCH_HEAD` after fetching one of those in the same repository
(the commit the job already has), a wildcard refspec that fetches everything,
and any other expression (its value cannot be read from the text, such as
`inputs.sha`). A peeling suffix (`verified^{commit}`, `$SHA^0`) names the same
commit. An ancestor (`HEAD~1`, `HEAD^`, `verified~1`, `$SHA^`) is a commit
nothing approved, so it reads as a name. `HEAD` on a remote
(`git fetch origin HEAD`) is that remote's default branch, a name.
`FETCH_HEAD` is a name too unless the job's last fetch in that repository
fetched a commit: before any fetch, after a fetch with no refspec, or after
anything else that may have changed it (a checkout `ref:`, a `--ref` flag, a
fetch whose text does not establish its repository or that may not run).
A git command is recognized however git is invoked or spelled: after global
options (`git --no-pager`, `git -c "key=a b"`, `git -C dir`), as
`command git`, a path to git, `"git"` or `g\it`, and inside a `$( … )`
substitution, nested or not.

**Only a command the shell would run, in a repository its text establishes,
can exempt anything.** Reading a git command errs toward flagging: text that
merely looks like one is read as one. Granting an exemption errs the other
way. A push or a fetch counts toward one only at a command position: not
text in a quoted string or a heredoc body, not an argument of another
command (`echo git push …`). Whether the shell reaches it
(`false && git push …`) is not read; [Known limits](#known-limits) lists that
and its siblings. Its repository must be known from its own text: the
checkout, or a `-C` directory. `--git-dir`, `--work-tree` and a `-c` setting
that can redirect the repository or remote (`remote.*`, `url.*`, `include*`,
`core.*`) leave it unknown.

A `git fetch` of a ref the same job pushes to is exempt: the job that writes
the rendered deployment state fetches its own release-state ref to commit to
it, and that ref is where it writes, not what it ships. The exemption needs a
push the lint positively recognizes as publishing that ref: a command that
runs, not a dry run (`-n`), a deletion (`-d`, `:<ref>`) or a mirror, from the
same repository (`-C`) to the same remote the fetch read, in a job that does
not move where its commands run (a `cd`, `pushd`, a step's
`working-directory:`, `GIT_DIR` or `GIT_WORK_TREE`, or a remote repointed with
`git remote set-url`). It never covers `verified`, which stays under the
resolve-once rule. In GitLab a job without `needs:` waits for every job in an
earlier stage, so a later-stage job has an upstream job unless it says
`needs: []`; a stage missing from the `stages:` order (or GitLab's default
order) is read as earlier, which errs toward flagging. Checking the written ref out, or deploying `FETCH_HEAD`
after fetching it, is still a selection by name. A `run:` or `script:` line
that is a YAML quoted scalar is read without those quotes, as the shell
receives it. Ref names keep their case: `Verified` is not the
`verified` pointer. A selection (b) already reports is not reported
again as (c). The subtleties the heuristic gets right:

- **`workflow_dispatch` is not a gate on a push run.** It is an *additional*
  manual trigger — `on: [push, workflow_dispatch]` still auto-deploys on every
  push. So (a) only clears on a real gate: an `environment:` key (where
  GitHub/GitLab **environment protection rules** — required reviewers, wait
  timers — are attached; the actual approval is a repo setting the lint can't
  see, so it checks the wiring hook exists and leaves the rule to the
  [maturity criterion](../../../../plugin/skills/audit/criteria/M10-environments-deploy.yaml)) or a GitLab `when: manual`.
- **A `verified` reference does not clear a mutable ref.** A line matcher cannot
  prove *which* line is the deploy command, so a `verified` reference elsewhere
  in the deploy job — a build-artifact download, a tooling checkout — cannot
  establish that the deploy itself ships verified. A job that checks out `main`,
  downloads a verified artifact, then runs `./deploy --ref main` is unsafe. The
  rule is therefore simple and sound: **a mutable ref anywhere in the
  production-deploy job is unsafe.** The safe shape carries no mutable ref at all
  — it deploys `ref: refs/tags/verified` or a downloaded `verified-*` artifact
  and never checks out a moving branch.
- **The `verified` pointer is safe by name only where it is resolved, and
  only once.** Rule (b) accepts the pointer, and a job with no upstream job
  (no `needs:`, or an empty `needs: []`) may resolve it by name: there the job
  *is* the gate. It may do so once: a second remote resolution in the same
  job (another checkout `ref:`, `--ref`, `git fetch` or `git pull` of it) can
  return a newer commit than the one its checks ran on, so the job deploys
  the commit it already has (`git rev-parse HEAD`, `FETCH_HEAD`). Local reads
  of the fetched name (`git checkout verified`, `git rev-parse verified`) are
  not a second resolution. A job with an upstream job is downstream of a gate,
  so resolving the pointer again re-reads a name that may have moved; it must
  take the commit from its upstream job's output instead.
- **Option arity follows the git verb.** `-m` takes a message in `git merge`
  but is a flag in `git checkout -m release`, which still selects `release`;
  after `--`, `git fetch`, `pull` and `push` still take a remote and refspecs,
  while the other verbs take paths.

## Mirror it on both rungs

The workflows are the thing being checked, so run it as a required check on every
PR that touches the deploy workflows, exactly as
[M7](../../../M7-pr-lifecycle-review/)'s reviewer-wiring lint does. A pre-commit
run is a nice-to-have; [CI](../../../../GLOSSARY.md) is the authority (see
[M1](../../../M1-gates-enforcement-ladder/)).

```sh
WORKFLOWS_DIR=.github/workflows bun ./check-promote-safety.ts
```

## Files

| File | Role |
|------|------|
| `check-promote-safety.ts` | the gate; `WORKFLOWS_DIR` or file args select inputs |
| `check-promote-safety.test.ts` | paired self-test |
| `fixtures/safe/` | manual+verified, env-gated push+verified, non-prod preview, push+dispatch **with** environment, env on the deploy job (other job bare), mutable ref on a non-deploy job, GitLab push rule **with** a gate (block, flow-mapping and quoted-key forms), block scalars with either indicator order, the gated commit passed as `needs.<job>.outputs.<sha>` (`ref:`, `git fetch`, `--ref`), the pointer fetched by name (also with a `^{commit}` suffix) in a job with no `needs:`, a digest-pinned `image-ref:` input, the rendered-state ref fetched and pushed to, a non-production deploy fetching a branch, a GitLab dotenv variable — must pass |
| `fixtures/unsafe/` | auto-push prod (a), push+dispatch with no env (a), env on a *different* job (a), GitLab job-level push rule ungated (a), flow-style `on: { push }` (a), quoted `on: "push"` (a), quoted `"only": [pushes]` (a), `when: manual` text inside a quoted flow-mapping value or an indent-first block scalar (a), quoted `"ref": main` (b), block-sequence `on: - push` (a), step-input environment not a gate (a), mutable branch ref (b), `--ref main` flag (b), `:latest` image (b), `verified` only in a step name (b), `verified` on a *different* job (b), mutable ref + in-job verified download (b), `ref: release` (c), `ref: ${{ inputs.branch }}` (c), `git fetch origin <branch>` in a run step (c), the pointer checked out again in a job that needs the gate (c), a pushed ref checked out and deployed (c), GitLab `git checkout origin/<branch>` (c) — must fail |

Run the self-test with `bun test ./check-promote-safety.test.ts`.

## Known limits

TypeScript job segmentation, not a full YAML evaluator. The checks are scoped to
the production-deploy job, but these residual imprecisions remain, all left to a
precise-parse version in whatever language the repo already uses (same reasoning
as [M7](../../../M7-pr-lifecycle-review/)'s lint):

- A "production-deploy job" is identified heuristically (a job carrying both a
  `deploy` and a `prod`/`production` signal). A job that merely mentions both in
  passing (a `notify` step logging "deploy to production done") could be
  mis-scoped — toward flagging, the safe direction.
- It reads a **job-level** `environment:` key (at the job-body indent, not a
  deeper step *input* named `environment`) as "a gate exists" — but it does not
  confirm the environment actually has required reviewers configured (that lives
  in repo settings, which the strict [maturity criterion](../../../../plugin/skills/audit/criteria/M10-environments-deploy.yaml)
  covers separately). Likewise, a GitLab `when: manual` anywhere in the job
  clears a push finding even if it belongs to a *different* rule than the
  push-matching one — binding a gate to the specific rule that fires on push is
  rules-list (first-match-wins) semantics that belong to the precise-parse
  version. Declare the deploy job's gate at job level, on the same rule as the
  push trigger.
- Job segmentation follows GitHub Actions (`jobs:` children) and GitLab
  (top-level jobs); an unusual structure, an anchored/`extends` job body, or a
  matrix that moves the deploy elsewhere may not segment cleanly. Push detection
  covers explicit triggers (GitHub `on: push`; GitLab `$CI_PIPELINE_SOURCE ==
  "push"` / `only: pushes`); a GitLab job that relies on the *default* "runs on
  every pipeline" behaviour with no explicit rule is not treated as
  push-firing — declare the deploy job `when: manual` (which this lint reads as
  a gate) so intent is explicit.
- Flow mappings are read when they sit on a single line; a flow mapping split
  across lines is not parsed for `when: manual`, which errs toward flagging.
- Because a line matcher can't bind a ref to the deploy command, rule (b) treats
  **any** mutable ref in the deploy job as unsafe rather than trying to prove
  it's the deployed one. A job that legitimately needs a mutable checkout for
  *tooling* while deploying a verified artifact will be flagged — restructure it
  (check out the verified tag, or run tooling from a separate job) or suppress
  it deliberately. It keys on the literal name `verified` (a shop that names its
  pointer differently should adjust the pattern).

- Rule (c) reads a git command on one line; a command continued with `\`
  onto the next line is read only up to the break. Text that merely looks like
  a git command (an `echo "git checkout release"`, a heredoc body) is read as
  one, which errs toward flagging; outside the shapes listed as missed below,
  it does not count as a push or a fetch that sets `FETCH_HEAD`. A command
  position is recognized at the start of a line or after `;`, `&&`, `||`,
  `|`, `(`, `{`, `$(`, `then`, `do` or `else`, past
  variable assignments and `command`/`exec`; a git command after any other
  prefix (`sudo git push`, `xargs git push`) does not exempt, which errs
  toward flagging. Quoting is
  tracked per line, so an apostrophe in plain text (`echo it's done`) reads
  the rest of the line as quoted: its comment is kept and its pushes do not
  exempt, which also errs toward flagging. A git command inside a
  double-quoted substitution (`"$(git push …)"`) is likewise not counted as a
  push.
- Rule (c) reads commands as they are written, not as the shell evaluates
  them, and these shapes are missed in the unsafe direction:
  - a fetch or push that may not run (`false && git fetch …`);
  - a git command line inside a quoted string that spans several lines;
  - a fetch that does not replace `FETCH_HEAD` (`--dry-run`,
    `--no-write-fetch-head`, `--append`);
  - a `FETCH_HEAD` read after a `cd` or under `GIT_DIR=`;
  - a verb spelled with quotes or escapes (`git "checkout"`, `chec\kout`, a
    YAML `\x`/`\u` escape);
  - the previous-checkout shorthand (`git switch -`, `git checkout -`);
  - `then`, `do`, `else` or `{` as an ordinary argument (`echo then git push
    …`, `echo {git fetch …`): the word is read as a command position wherever
    it stands, so the echoed push or fetch counts as one that runs.

  Deciding these needs a real shell parse of each run step. Until the lint
  has one, write deploy-job commands plainly: one unconditional fetch by
  commit hash, its `FETCH_HEAD` read in the same directory, and every ref
  named in full.
- A shell redirection is read as a git operand: `git fetch origin "$SHA"
  >/dev/null`, `git checkout "$SHA" 2>/dev/null` and `git rev-parse HEAD >
  gated-sha` report the redirection as a name, which errs toward flagging.
  Leave redirections off deploy-job git commands: use `--quiet`, or capture
  the output (`SHA=$(git rev-parse HEAD)`) and write it in its own command.
- The push exemption compares the repository as written: a push from a
  worktree of the same repository under another `-C` directory does not
  match a fetch from the checkout's root, and a remote is compared with its
  quotes (`git fetch origin …` does not match `git push "origin" …`); both
  err toward flagging, so write the repository and remote the same way in
  the fetch and the push. A job
  that changes directory anywhere (`cd`), even back to where it started,
  loses the exemption; write `git -C <dir>` instead. Fetch
  and push from the same place (a worktree shares the repository's refs, so
  `git push origin <branch>:<ref>` from the root publishes a worktree's
  commit).
- A checkout with **no** `ref:` is not flagged by (c): it checks out the
  commit the run started on, which stays fixed for the whole run, but is not
  necessarily the commit the gate approved. In a multi-job promotion give
  every checkout the upstream job's output.
- Rule (c) examines only jobs that look like a production deploy (the
  `deploy` + `prod` pair above). Other jobs of a promotion, such as a
  migration job or an identity check with no deploy wording, are not checked;
  inspect how they take their commit by hand.
- Rule (c) cannot tell a file path from a ref: `git checkout package-lock.json`
  without `--` is read as a selection by name, which errs toward flagging.
  Write `git checkout -- <path>`.
- A checkout of **another** repository (`repository:` with `ref: v2.3.0`) is
  read as this job selecting its commit by name. Check that repository out in
  a job that is not the deploy job, or pin it to a commit hash.
- Rule (c) cannot tell what an expression it does not recognise holds: a
  name-shaped one (`inputs.branch`, `github.head_ref`) is read as a name, any
  other (`inputs.sha`, `steps.x.outputs.y`, `env.TARGET`) is not.

The biases are toward the safe direction for the deploy path — a false positive
is a two-line review, a false negative ships the wrong bits.
