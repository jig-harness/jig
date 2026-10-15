// Scope: Jig's own CI (`.github/workflows/`, and composite actions under
// `.github/actions/` when there are any), through M13's workflow-convention
// lint (modules/M13-pipeline-economy/reference/workflow-conventions), with
// Jig's values from `.config/jig.yaml`, its heavy suites from
// `.config/workflow-conventions.yaml` and its reasoned exceptions from
// `.config/workflow-conventions-exceptions.txt`. Exit 1 on a finding; 2 when
// an input cannot be read or parsed, or no workflow is found, since Jig always
// has workflows and a run that read none has checked nothing.
import { cli } from "../lib/cli.ts";
import { lintWorkflowConventions } from "../modules/M13-pipeline-economy/reference/workflow-conventions/check-workflow-conventions.ts";

export function checkWorkflowConventions(
  root = ".",
  env: Record<string, string | undefined> = process.env,
): number {
  return lintWorkflowConventions({ root, requireWorkflows: true }, env);
}
if (import.meta.main) cli(() => checkWorkflowConventions(process.argv[2]));
