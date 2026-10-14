// Scope: Jig's own CI workflows (`.github/workflows/*.yml` and `*.yaml`),
// through M7's PR-target safety lint
// (modules/M7-pr-lifecycle-review/reference/pr-target-safety). The workflows
// are safe today; this keeps them so. Exit 1 when a workflow triggered by
// `pull_request_target` checks out the pull request's own code and runs a
// step, which would hand a fork's code the job's secrets; 2 when the folder
// cannot be read or holds no workflow, since Jig always has workflows and a
// run that read none has checked nothing.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { couldNotCheck } from "../lib/findings.ts";
import { prTargetSafety } from "../lib/module-gates.ts";

export function checkWorkflowSafety(
  root = ".",
  env: Record<string, string | undefined> = process.env,
): number {
  const dir = join(root, ".github/workflows");
  const workflows = existsSync(dir)
    ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
    : [];
  if (!workflows.length)
    return couldNotCheck("workflow-safety", `no workflow file in ${dir}`, env);
  const { code, stdout, stderr } = prTargetSafety([], {
    WORKFLOWS_DIR: dir,
  });
  if (code) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    return code;
  }
  console.log(
    `workflow-safety: OK — ${workflows.length} workflows; none runs a fork's code under pull_request_target`,
  );
  return 0;
}
if (import.meta.main) cli(() => checkWorkflowSafety(process.argv[2]));
