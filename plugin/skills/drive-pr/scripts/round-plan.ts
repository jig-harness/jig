#!/usr/bin/env bun
/**
 * Resolve the validation plan to run before this round's commit and push.
 *
 * CUMULATIVE by default: the PR's whole diff against its own base
 * (`origin/<base>`), checked after every review fix, not merely once per PR.
 * For a stacked layer the base is the layer below, so the plan covers this
 * layer alone; the layers beneath are validated by their own drives. A branch
 * with no pull request diffs against the integration branch
 * (`repository.base_branch`); a pull request whose base cannot be read,
 * fetched or trusted is refused rather than planned against another branch
 * (`prBaseRef`).
 *
 * Where the plan comes from is the consumer's: `drive.validation_plan_command`
 * in `.config/jig.yaml` reads the changed files on stdin (one
 * per line) and prints the plan as JSON on stdout. A repository that declares
 * none gets a one-step plan, its `gates.command`, the complete local checks.
 * The JSON contract this script reads:
 *
 *   { validation: { localChecks: string[], verificationChecks: string[],
 *                   testbox: { required: boolean, command?, warmupCommand?,
 *                              reason?, requiredBy?: [{area, files}] } },
 *     seedAreas?, reviewSkills?: string[], linear? }
 *
 * `testbox` is the plan's remote-runner half: a heavier box the plan may ask
 * for on top of the local checks. A plan that never needs one emits
 * `required: false`.
 *
 * The delta view (`--delta`) exists and is genuinely cheaper (measured on one
 * reference PR: a Markdown-only round resolved to a formatter and a docs index
 * with no remote box, against a cumulative plan of full gates plus a box). It
 * is NOT the default, because cheaper is not the property that matters: round
 * N's fix can interact with a file round 1 changed, and no plan derived from
 * round N's own diff contains the check that would catch it. The combined
 * tree is what gets pushed, so the combined tree is what gets validated.
 * Reach for `--delta` only to see what this round touched, or when you are
 * deliberately taking that risk on a round you have reasoned about, and say
 * so.
 *
 * The delta base is the last SHA whose validation actually passed
 * (`drive-state.ts verified`), so a round that failed its gates re-validates
 * everything it touched rather than only what changed since the failure.
 *
 * One rule the caller still owns, because it is not derivable from a diff:
 * warm a remote box only when the emitted plan demands one, and as a
 * SINGLE-USE box warmed immediately after the last local build task. A box
 * reused across rounds, or warmed before the latest local run, went stale
 * three times out of three when measured.
 *
 * REMOTE-BOX DECAY. The cumulative scope is right for the CHECKS and wrong for
 * the BOX, and this script says which of the two it is answering. A round-N
 * fix can interact with a file round 1 changed, so the cheap checks stay
 * cumulative: that argument is about the tree's CURRENT contents. The box is a
 * different question: it re-runs tests and builds that already passed on the
 * last green-verified SHA. So the box is warranted by what changed SINCE that
 * SHA, not by what the PR contains. Measured:
 * a fixed set of round-1 files held `testbox.required: true` for a dozen
 * rounds that never touched them, while its pre-push hook (which scopes
 * incrementally) skipped its heavy phase on the same commits. This block
 * resolves that in ONE direction and prints the divergence rather than leaving
 * it to be discovered.
 *
 * It fails CLOSED in every ambiguous case: no verified SHA recorded, a
 * verified SHA this clone cannot resolve, or a failed delta resolution all
 * keep the cumulative answer. And the decay predicate is the PLAN COMMAND's
 * own `validation.testbox.required` over the delta file list, never a
 * re-derived opinion here: one definition of "does this file set warrant a
 * box" is the whole point. A plan command that stops emitting that field as a
 * boolean is not an ambiguous case but a broken contract, and the plan read
 * STOPS rather than reading the absence as "no box needed".
 *
 * Usage: round-plan.ts [PR] [--delta] [--since SHA] [--json]
 *
 *   --delta       resolve only what changed since the last verified SHA,
 *                 instead of the PR's whole diff. An optimization, never a
 *                 substitute.
 *   --cumulative  the default; accepted so a caller can state it explicitly
 *   --since SHA   override the delta base (default: the recorded verified
 *                 SHA); implies --delta
 *   --json        emit the plan JSON with the plan envelope; otherwise
 *                 print the commands to run
 *
 * In text mode, a repository that declares `drive.load_guard_command` gets it
 * run first: it waits until the machine's load allows this round's heavy
 * checks, so the plan is not printed into a machine that would refuse them.
 * A guard that fails is reported and does not block the plan.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, runMain, short } from "./lib/cli.ts";
import {
  gatesCommand,
  loadGuardCommand,
  prBaseRef,
  shellArgv,
  validationPlanCommand,
} from "./lib/overlay.ts";
import {
  git,
  gitCallTimeoutSeconds,
  run,
  unconcludedGitOpMarker,
} from "./lib/proc.ts";
import {
  changedFilesSince,
  readVerifiedSha,
  roundBase,
} from "./lib/round-delta.ts";

const here = dirname(fileURLToPath(import.meta.url));
const driveState = join(here, "drive-state.ts");

/**
 * Run the consumer's load guard (`drive.load_guard_command`), which waits
 * until the machine's load allows this round's heavy checks. `null` when no
 * guard is configured or it succeeded; otherwise the warning line to print.
 * Its own output goes to stderr, never stdout, which carries the plan.
 */
export async function runLoadGuard(root: string): Promise<string | null> {
  const command = loadGuardCommand();
  if (command === undefined) return null;
  const r = await run(shellArgv(command), {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.code === 0) return null;
  return `⚠ LOAD: the load guard (${command}) exited ${r.code}; this round's heavy checks may be refused.`;
}

interface ResolvedPlan {
  seedAreas?: unknown;
  validation: {
    localChecks?: string[];
    verificationChecks?: string[];
    testbox: {
      required: unknown;
      command?: string | null;
      warmupCommand?: string | null;
      reason?: string | null;
      requiredBy?: Array<{ area: string; files: string[] }>;
    };
    [extra: string]: unknown;
  };
  reviewSkills?: string[];
  linear?: unknown;
  [extra: string]: unknown;
}

/**
 * The plan for a repository that declares no plan command: its complete
 * local checks (`gates.command`) as the single local check, and no remote box.
 */
export function gatesOnlyPlan(command: string): ResolvedPlan {
  return {
    validation: {
      localChecks: [command],
      verificationChecks: [],
      testbox: { required: false, command: null, warmupCommand: null },
    },
    reviewSkills: [],
  };
}

/**
 * Run the consumer's plan command (`drive.validation_plan_command`) over a
 * file list. Without one, the plan is `gates.command` alone; without either,
 * there is nothing to plan from ('unconfigured').
 *
 * A non-zero exit ('failed') and an exit-0 payload that is not usable JSON
 * ('malformed') are reported apart, because the two notes the decay block
 * prints for them are different claims: a plan command that DIED versus one
 * that answered in a shape the contract does not allow.
 */
async function resolveFiles(
  root: string,
  files: string[],
): Promise<
  | { ok: true; plan: ResolvedPlan }
  | { ok: false; why: "failed" | "malformed" | "no-shell" | "unconfigured" }
> {
  const command = validationPlanCommand();
  if (command === undefined) {
    const gates = gatesCommand();
    if (gates === undefined) return { ok: false, why: "unconfigured" };
    return { ok: true, plan: gatesOnlyPlan(gates) };
  }
  const r = await run(shellArgv(command), {
    cwd: root,
    stdin: `${files.join("\n")}\n`,
    stderr: "inherit",
  });
  // "The command never ran at all" is a different diagnosis from "the plan
  // command failed". Read off `spawnFailed`, never `code === 127`: a real
  // child may exit 127 too.
  if (r.spawnFailed) return { ok: false, why: "no-shell" };
  if (r.code !== 0) return { ok: false, why: "failed" };
  try {
    const plan = JSON.parse(r.stdout) as ResolvedPlan;
    if (typeof plan !== "object" || plan === null)
      return { ok: false, why: "malformed" };
    return { ok: true, plan };
  } catch {
    return { ok: false, why: "malformed" };
  }
}

/**
 * `validation.testbox.required` is a CONTRACT, and the whole decay block is a
 * fail-closed argument built on it — so read it as one. A loose read hands
 * back `null` on an absent, null or string-typed field, which is neither
 * `true` nor `false`: the decay branch never runs, the printed plan says "not
 * required", and the JSON emits `required: null`. That is a fail-OPEN — a
 * resolver contract regression would silently retire the box — in a script
 * whose stated invariant is that every ambiguous case KEEPS the cumulative
 * answer. Type-check it so a regression is a loud stop.
 */
function testboxRequiredOf(plan: ResolvedPlan): boolean | null {
  const v = plan.validation?.testbox?.required;
  return typeof v === "boolean" ? v : null;
}

async function main(): Promise<number> {
  let pr = "";
  let mode: "cumulative" | "delta" = "cumulative";
  let since = "";
  let json = false;

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "--cumulative":
        mode = "cumulative";
        break;
      case "--delta":
        mode = "delta";
        break;
      case "--json":
        json = true;
        break;
      case "--since": {
        const value = argv[i + 1];
        if (value === undefined) fail(2, "--since requires a value");
        since = value;
        mode = "delta";
        i++;
        break;
      }
      default:
        if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
        pr = a;
    }
  }

  const rootRes = await git(["rev-parse", "--show-toplevel"], {
    stderr: "inherit",
  });
  if (rootRes.code !== 0) return rootRes.code;
  const root = rootRes.stdout.trim();

  // The refusal drive-pr `SKILL.md` § 5's validation plan's resolve snippet
  // makes, for the five markers the shared probe checks (MERGE_HEAD,
  // CHERRY_PICK_HEAD, REVERT_HEAD, rebase-merge, rebase-apply). The snippet
  // also refuses on `sequencer/todo`; the probe does not yet, for any of its
  // callers. Mid-merge, `git diff <base>` compares against a working tree that
  // still holds the whole incoming operation, so the plan inflates to it:
  // measured at 78 files and a Testbox demand, versus 13 once the merge was
  // committed. `PR_CONFLICTING` makes a mid-merge invocation the likely case,
  // not an edge one. Both modes, since a delta base is diffed against that same
  // working tree. An unreadable probe fails closed — "cannot confirm" is not
  // "confirmed none".
  const op = await unconcludedGitOpMarker(gitCallTimeoutSeconds(), {
    cwd: root,
  });
  if (!op.ok) {
    fail(
      1,
      "round-plan: cannot establish that no git operation is open (the git-dir probe did not complete) — refusing to emit a plan",
    );
  }
  if (op.marker !== null) {
    fail(
      1,
      `round-plan: an unconcluded git operation is present (${op.marker}) — refusing to resolve.`,
      "Mid-operation, the diff against the base includes the whole incoming operation,",
      "not just this branch, so the plan would validate the wrong file set.",
      "Conclude it (commit the merge / git rebase --continue) or abort it",
      "(git merge/cherry-pick/revert/rebase --abort; git am --abort for a paused am), then re-run.",
    );
  }

  // Printed first, ahead of everything else the plan says — before this
  // round's own heavy checks run into the same guard. JSON output is piped
  // to other tooling (verification-fit.ts) and must stay pure JSON, so this
  // is text-mode only, the same split `deltaCaveat()` below makes.
  if (!json) {
    const warning = await runLoadGuard(root);
    if (warning !== null) process.stdout.write(`${warning}\n\n`);
  }

  if (mode === "delta" && since === "") {
    // `null` (the read itself failed) and `''` (legitimately no SHA
    // recorded) both mean "no usable delta base" for this already-explicit,
    // operator-opted-in flag — fold them the same way this block always
    // has. `roundBase()`'s own callers (below, and `finish-round.ts`) are
    // where the two are told apart and a read failure fails closed instead.
    const verifiedSha = await readVerifiedSha(pr, driveState);
    since = verifiedSha ?? "";
    if (since === "") {
      // No round has been verified yet, so there is no delta to speak of —
      // the first round's delta IS the cumulative diff. Say so rather than
      // silently resolving an empty file list, which would emit an empty plan
      // and read as "nothing to validate".
      console.error(
        "round-plan: no verified SHA recorded yet — falling back to the cumulative plan",
      );
      mode = "cumulative";
    }
  }

  let base = "";
  if (mode === "cumulative") {
    const resolved = await prBaseRef(root, pr);
    if ("error" in resolved) fail(1, `round-plan: ${resolved.error}`);
    const ref = resolved.ref;
    const mb = await git(["merge-base", ref, "HEAD"], {
      stderr: "inherit",
    });
    if (mb.code !== 0) {
      fail(1, `round-plan: cannot resolve merge-base against ${ref}`);
    }
    base = mb.stdout.trim();
  } else {
    base = since;
    const exists = await git(["cat-file", "-e", `${base}^{commit}`], {
      stderr: "ignore",
    });
    if (exists.code !== 0) {
      fail(
        1,
        `round-plan: recorded verified SHA '${base}' is not a commit in this clone`,
      );
    }
  }

  const files = await changedFilesSince(root, base);
  if (files === null) {
    fail(
      1,
      `round-plan: cannot list the files changed since ${short(base)} — refusing to emit a plan`,
    );
  }

  // Printed on EVERY delta plan, including the empty one. An empty delta is
  // where the caveat matters most, not least: "no files changed — nothing to
  // validate" is the most convincing possible way to read a scoping choice as
  // an all-clear, while the cumulative tree it omits still has everything the
  // earlier rounds put there and is still what gets pushed.
  const deltaCaveat = (): void => {
    if (mode !== "delta") return;
    process.stdout.write(
      `\n⚠ DELTA plan: scoped to what changed since ${short(base)}, so it can omit a check\n`,
    );
    process.stdout.write(
      "  that an earlier round's files still need. The tree being pushed is the\n",
    );
    process.stdout.write(
      "  cumulative one — drop --delta unless you have reasoned about that gap.\n",
    );
  };

  if (files.length === 0) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          mode,
          base,
          files: [],
          empty: true,
          validation: {
            localChecks: [],
            verificationChecks: [],
            testbox: {
              required: false,
              command: null,
              warmupCommand: null,
              reason: null,
              requiredBy: [],
            },
          },
          testboxDecision: {
            required: false,
            planRequired: false,
            incrementalRequired: null,
            decayed: false,
            requiredBy: [],
            verifiedSha: null,
            note: null,
          },
          reviewSkills: [],
        })}\n`,
      );
    } else {
      process.stdout.write(
        `round-plan (${mode}, base ${base}): no files changed — nothing to validate this round.\n`,
      );
      deltaCaveat();
    }
    return 0;
  }

  const resolvedRes = await resolveFiles(root, files);
  if (!resolvedRes.ok) {
    if (resolvedRes.why === "unconfigured")
      fail(
        1,
        "round-plan: this repository declares neither drive.validation_plan_command nor",
        "gates.command in .config/jig.yaml, so there is no plan to emit.",
      );
    if (resolvedRes.why === "no-shell")
      fail(
        1,
        "round-plan: the shell could not be started, so drive.validation_plan_command never ran.",
      );
    if (resolvedRes.why === "failed")
      fail(1, "round-plan: drive.validation_plan_command failed");
    // `malformed` means the resolver exited 0 and its stdout was not a JSON
    // object. Naming validation.testbox.required here sent the operator to
    // inspect a field that was never reached;
    // that message belongs to the later check, which still carries it.
    fail(
      1,
      "round-plan: drive.validation_plan_command exited 0 but did not emit a JSON object — refusing to guess",
    );
  }
  const resolved = resolvedRes.plan;

  // ── Testbox decay ───────────────────────────────────────────────
  // See the header. `planTestbox` is what THIS plan's scope answered;
  // `testboxRequired` is the answer to act on. They differ only when a
  // cumulative plan's requirement is held up entirely by files that predate
  // the last green-verified SHA — and when they differ, both are printed.
  const planTestbox = testboxRequiredOf(resolved);
  if (planTestbox === null) {
    fail(
      1,
      "round-plan: drive.validation_plan_command did not emit a boolean validation.testbox.required — refusing to guess",
    );
  }
  let testboxRequired = planTestbox;
  let incrementalTestbox: boolean | null = null;
  let decayed = false;
  let verifiedSha = "";
  let decayNote = "";

  if (mode === "cumulative" && planTestbox) {
    // `roundBase` runs the identical fail-closed chain this block always has
    // (recorded? resolvable in this clone? an ancestor of HEAD?) — shared
    // with `finish-round.ts`'s own untriaged-thread guard, which asks the
    // same "what is this round's base" question with no cumulative `base`
    // already in scope the way this script has. `rb.base` is therefore
    // unused here — `base` above already holds the cumulative merge-base for
    // a cumulative-mode plan — only `rb.sha` (null on any fallback) and
    // `rb.note` (that fallback's reason, empty when `sha` validated) matter
    // to this block.
    const rb = await roundBase(root, pr, driveState);
    verifiedSha = rb.sha ?? "";
    if (rb.sha === null) {
      // `rb.note`'s subject is a ROUND BASE falling back — right for
      // `finish-round.ts`'s guard, wrong here: this block's subject is the
      // TESTBOX REQUIREMENT decaying. `rb.reason` is the bare fact without
      // that subject baked in, so this composes the sentence this block
      // actually means rather than repeating `note`'s wording under someone
      // else's subject.
      decayNote = `${rb.reason}, so the requirement cannot decay (fail-closed)`;
    } else {
      // Same file-list construction as the plan's own, against the verified
      // SHA instead of the merge-base — including untracked files, and
      // checked the same way, for the same reasons.
      const deltaFiles = await changedFilesSince(root, verifiedSha);
      if (deltaFiles === null) {
        decayNote =
          "the delta file list could not be computed, so the requirement cannot decay (fail-closed)";
      } else if (deltaFiles.length === 0) {
        // Nothing at all has changed since a tree whose gates passed green.
        incrementalTestbox = false;
      } else {
        const deltaResolved = await resolveFiles(root, deltaFiles);
        if (!deltaResolved.ok) {
          decayNote =
            deltaResolved.why === "failed"
              ? "the delta resolution failed, so the requirement cannot decay (fail-closed)"
              : "the delta resolution did not emit a boolean testbox requirement, so the requirement cannot decay (fail-closed)";
        } else {
          // The RESOLVER's own answer over the delta, never a predicate
          // re-derived here: one definition of "does this file set warrant a
          // box". Same type-check as the plan's own read, but a malformed
          // answer here is NOT fatal: an unusable delta is precisely the
          // ambiguous case the block already resolves by keeping the
          // cumulative requirement.
          incrementalTestbox = testboxRequiredOf(deltaResolved.plan);
          if (incrementalTestbox === null) {
            decayNote =
              "the delta resolution did not emit a boolean testbox requirement, so the requirement cannot decay (fail-closed)";
          }
        }
      }
      if (incrementalTestbox === false) {
        testboxRequired = false;
        decayed = true;
        // Stated in the payload as well as the printed plan. `validation` is
        // left exactly as the resolver emitted it — overwriting it would
        // misreport what the resolver said — so a JSON consumer has two
        // fields to choose between and needs to be told which one is the
        // answer, in the payload it is already reading rather than only in a
        // doc it may not be.
        decayNote = `decayed: no Testbox-opted-in area has changed since ${short(verifiedSha)}, whose gates passed green — act on testboxDecision.required, not validation.testbox.required`;
      }
    }
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        mode,
        base,
        files,
        empty: false,
        seedAreas: resolved.seedAreas ?? [],
        validation: resolved.validation,
        testboxDecision: {
          required: testboxRequired,
          planRequired: planTestbox,
          incrementalRequired: incrementalTestbox,
          decayed,
          requiredBy: resolved.validation.testbox.requiredBy ?? [],
          verifiedSha: verifiedSha === "" ? null : verifiedSha,
          note: decayNote === "" ? null : decayNote,
        },
        reviewSkills: resolved.reviewSkills ?? [],
        linear: resolved.linear ?? {},
      })}\n`,
    );
    return 0;
  }

  const out = (s: string): void => {
    process.stdout.write(s);
  };
  out(`round-plan (${mode}, base ${short(base)}): ${files.length} file(s)\n\n`);
  out("Local checks (before commit):\n");
  for (const c of resolved.validation.localChecks ?? []) out(`  ${c}\n`);
  out("\nVerification checks (before push):\n");
  for (const c of resolved.validation.verificationChecks ?? []) out(`  ${c}\n`);
  // The files that made the plan's `testbox.required` true, one per line, each
  // tagged with the `profile: full` area it matched. Printed
  // whether or not the requirement decays: when it holds, this is what the
  // box is FOR; when it decays, this is the evidence that it is stale.
  const printRequiredBy = (): void => {
    for (const entry of resolved.validation.testbox.requiredBy ?? []) {
      for (const f of entry.files) out(`    ${f}  (${entry.area})\n`);
    }
  };

  if (testboxRequired) {
    // The plan contract (see the header) is that both
    // commands are non-null exactly when required is true. Substituting ''
    // on a contract violation would silently print a blank warmup or run
    // line instead of provisioning/executing anything — the opposite of
    // fail-closed. Validate it explicitly rather than trust it silently.
    const warmupCommand = resolved.validation.testbox.warmupCommand;
    const runCommand = resolved.validation.testbox.command;
    if (!warmupCommand || !runCommand) {
      fail(
        1,
        "round-plan: Testbox is required but the plan omitted validation.testbox.warmupCommand or .command — refusing to guess",
      );
    }
    out(
      `\nTestbox: REQUIRED for this ${mode} plan. Warm a SINGLE-USE box immediately\n`,
    );
    out("after the last local build task:\n");
    // Printed rather than left to the operator's memory of the skill: a bare
    // warmup took the provider's 30-minute idle default, and that floor was
    // measured at 49% of every runner-minute a box held.
    out(`  ${warmupCommand}\n`);
    out(
      "\nthen run (it stops the box itself, except on a retryable code failure;\n",
    );
    out("--keep always holds it):\n");
    out(`  ${runCommand}\n`);
    out("\n  Required by:\n");
    printRequiredBy();
    if (decayNote !== "") out(`  Not decayed: ${decayNote}.\n`);
  } else if (decayed) {
    out("\nTestbox: NOT required this round — do not warm one.\n");
    out(`  The ${mode} plan asks for one, but only on the strength of\n`);
    out(
      `  Testbox-opted-in area file(s) unchanged since the last green-verified\n  SHA ${short(verifiedSha)}:\n`,
    );
    printRequiredBy();
    out(
      "  Nothing changed since that SHA warrants a box, so one would re-run a\n",
    );
    out(
      "  suite that already passed on this tree. A pre-push hook that scopes its\n",
    );
    out("  heavy phase to the push range agrees for the same reason.\n");
  } else {
    out(`\nTestbox: not required for this ${mode} plan — do not warm one.\n`);
  }
  const skills = (resolved.reviewSkills ?? []).join(", ");
  if (skills !== "") out(`\nMandatory review skills: ${skills}\n`);
  deltaCaveat();
  return 0;
}

// Gated behind `import.meta.main` rather than run at module scope: this
// module's side effect is real git/resolver I/O and a process exit code, so
// importing it unconditionally — the pattern `loadWarningLine` otherwise
// supports — would run the whole CLI for real. This is what lets
// round-plan.test.ts import `loadWarningLine` directly without triggering the
// CLI. The predicate is `lib/cli.ts`'s, no longer inlined here: the inline
// form compared `resolve(argv[1])` rather than its REALPATH, so it answered
// false — and skipped the CLI entirely — for an invocation through the
// `.agents/skills/` symlink farm or any path with a symlink component.
if (import.meta.main) runMain("round-plan.ts", main);
