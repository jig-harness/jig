// Renders the live audit example into public/examples/audit/ before each
// build, with the audit skill's own renderer and the committed run on a
// public repository, so the site shows the sheet the current renderer
// produces and never keeps a copy of it. Needs the repository's own
// dependencies installed (`bun install` at the root).
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const audit = join(root, "plugin/skills/audit");
const fixtures = join(audit, "__tests__/fixtures/report");
const out = fileURLToPath(new URL("../public/examples/audit", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "jig-audit-example-"));

try {
  const run = Bun.spawnSync(
    [
      "bun",
      join(audit, "scripts/report.ts"),
      "render",
      join(fixtures, "execa.report.json"),
      "--record",
      join(audit, "calibration/2026-10-12-execa.jig-audit.yaml"),
      "--fit",
      join(fixtures, "execa.fit.json"),
      "--out",
      scratch,
      // The example audits another repository, not the one this runs in.
      "--other-repository",
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  if (run.exitCode !== 0)
    throw new Error(`the audit renderer exited with ${run.exitCode}`);
  mkdirSync(out, { recursive: true });
  // A copy, not a rename: the scratch directory may be on another filesystem.
  copyFileSync(
    join(scratch, "jig-audit-2026-10-12.html"),
    join(out, "execa-63ddae6.html"),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
