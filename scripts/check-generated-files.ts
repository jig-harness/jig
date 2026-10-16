// Scope: Jig's own derived files, each declared once as a `generated:` entry
// of the area that owns it in the change-area catalog
// (.config/change-areas.yaml, module M3), run through M2's generic runner
// from the repository root: every declared check runs whatever the earlier
// ones did, and a stale output names its regenerate command. The runner
// also checks the declarations (each output a file declared once and
// matched by its area's paths, each source glob matching a repository
// file). Exit 1 when a check finds a stale output or a declaration does not
// hold, 2 when the catalog cannot be read, declares no generated file, or a
// check cannot start or decide.
import { cli } from "../lib/cli.ts";
import { main as runGeneratedChecks } from "../modules/M2-generated-artifact-freshness/reference/inventory/run-generated-checks.ts";
import { CATALOG } from "./change-areas.ts";

export function checkGeneratedFiles(root = "."): Promise<number> {
  return runGeneratedChecks([CATALOG], { cwd: root });
}

if (import.meta.main) cli(() => checkGeneratedFiles());
