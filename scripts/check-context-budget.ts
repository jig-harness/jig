// Scope: Jig's own always-loaded context, measured with M0's context-budget
// reference gate. The instruction chain covers every AGENTS.md git lists,
// fixtures included, since a runtime working in that directory loads them.
// The discovery budget covers the plugin's skills and agents only: they are
// what every consumer of the plugin pays for in each session, so the soft
// description target fails here instead of being reported. Jig's own skills
// (.claude/skills) are listed by their bare name in the same session as the
// installed plugin's, so they are measured in one listing with them. Skills
// under seeds/ are frozen source material no runtime lists, and are left out.
// Built-ins only, so CI runs it before installing dependencies.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { checkDiscoveryBudget } from "../modules/M0-instruction-architecture/reference/context-budget/check-discovery-budget.ts";
import { checkInstructionChain } from "../modules/M0-instruction-architecture/reference/context-budget/check-instruction-chain.ts";

export function checkContextBudget(root = "."): number {
  const chain = checkInstructionChain([root]);
  const own = join(root, ".claude/skills");
  const discovery = checkDiscoveryBudget([
    "--skills",
    join(root, "plugin/skills"),
    // Absent is fine; anything at the path, a broken link included, is
    // passed on, and the discovery check refuses what it cannot read.
    ...(lstatSync(own, { throwIfNoEntry: false })
      ? ["--bare-skills", own]
      : []),
    "--agents",
    join(root, "plugin/agents"),
    "--namespace",
    "jig",
    "--fail-soft",
  ]);
  return Math.max(chain, discovery);
}
if (import.meta.main) cli(() => checkContextBudget(process.argv[2]));
