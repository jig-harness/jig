// Canonical ordered gate set: self-tests first, then repository checks.
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { checkLinks } from "./check-md-links.ts";
import { checkTables } from "./check-md-tables.ts";
import { checkGlossary } from "./check-glossary-coverage.ts";
import { checkTracker } from "./check-no-tracker-refs.ts";
const root = join(import.meta.dir, "..");
async function gates(): Promise<number> {
  for (const args of [
    ["run", "format:check"],
    ["run", "lint"],
    ["run", "typecheck"],
    ["test"],
    ["run", "build"],
  ]) {
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
    const status = await child.exited;
    if (status) return status;
  }
  for (const check of [checkLinks, checkTables, checkGlossary, checkTracker]) {
    const status = check(root);
    if (status) return status;
  }
  console.log("all gates passed");
  return 0;
}
if (import.meta.main) cli(gates);
