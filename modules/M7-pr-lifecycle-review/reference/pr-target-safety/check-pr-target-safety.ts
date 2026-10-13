// PR-target safety lint: fork-unsafe reviewer wiring must fail loudly.
//
// The problem it catches. An automated reviewer needs repository secrets (model
// keys, a bot token) to post its findings, so its workflow runs with the
// `pull_request_target` trigger — which executes in the BASE repo's privileged
// context (secrets + a write token) even for PRs from forks. If such a workflow
// ALSO checks out the untrusted PR head / fork code AND then runs code (a
// `run:` step, or an `npm install` firing lifecycle scripts), a forked PR can
// exfiltrate those secrets. This is a well-known CI foot-gun, not a hypothetical.
//
// The safe pattern (see README): under `pull_request_target`, treat fork code
// as DATA — analyze the diff, don't execute the PR's own code in the privileged
// job. A reviewer that must run the PR's build belongs on the `pull_request`
// trigger (no secrets) with results handed back via artifacts.
//
// What this flags — a workflow where ALL THREE hold:
//   1. it is triggered by `pull_request_target`, AND
//   2. it checks out a ref it cannot show to be the base (a `ref:`/`repository:`
//      value naming a `pull/` ref or holding any expression outside the base
//      side of the pull request; the list is in the README), AND
//   3. it has an execution path: a `run:` step or a local `uses: ./` action.
// High-recall by design: a false positive is a two-line review; a false
// negative is a leaked secret. A workflow that omits any of the three passes.
// Workflows are read with Bun's YAML parser; one that does not parse exits 2.
//
// Conventions (see ../../../M1-gates-enforcement-ladder/reference/grep-gate):
// exit 0 on pass, 1 on an unsafe workflow (per-file report), 2 on a usage
// error; inputs via args or WORKFLOWS_DIR so the self-test drives it with
// fixtures. A missing workflows dir passes (safe to wire early).
//
// Usage:
//   check-pr-target-safety.ts                       # scan .github/workflows
//   check-pr-target-safety.ts path/to/wf.yml ...    # explicit files
//   WORKFLOWS_DIR=path check-pr-target-safety.ts
import { runGate } from "../../../../lib/module-gates.ts";

if (import.meta.main)
  process.exitCode = await runGate("check-pr-target-safety");
