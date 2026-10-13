// Scope: Jig's own CI workflows (`.github/workflows/*.yml` and `*.yaml`),
// through M7's PR-target safety lint
// (modules/M7-pr-lifecycle-review/reference/pr-target-safety). The workflows
// are safe today; this keeps them so. Exit 1 when a workflow triggered by
// `pull_request_target` checks out the pull request's own code and runs a
// step, which would hand a fork's code the job's secrets; 2 when the folder
// cannot be read. A repository without workflows passes.
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { prTargetSafety } from "../lib/module-gates.ts";

export function checkWorkflowSafety(root = "."): number {
  const { code, stdout, stderr } = prTargetSafety([], {
    WORKFLOWS_DIR: join(root, ".github/workflows"),
  });
  if (code) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  }
  return code;
}
if (import.meta.main) cli(() => checkWorkflowSafety(process.argv[2]));
