// Scope: Jig's own always-loaded context, measured with M0's context-budget
// reference gate. The instruction chain covers every AGENTS.md git lists,
// fixtures included, since a runtime working in that directory loads them.
// The discovery budget covers the plugin's skills and agents only: they are
// what every consumer of the plugin pays for in each session, so the soft
// description target fails here instead of being reported. Skills under
// seeds/ are frozen source material no runtime lists, and are left out.
// Built-ins only, so CI runs it before installing dependencies.
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { checkDiscoveryBudget } from "../modules/M0-instruction-architecture/reference/context-budget/check-discovery-budget.ts";
import { checkInstructionChain } from "../modules/M0-instruction-architecture/reference/context-budget/check-instruction-chain.ts";

export function checkContextBudget(root = "."): number {
  const chain = checkInstructionChain([root]);
  const discovery = checkDiscoveryBudget([
    "--skills",
    join(root, "plugin/skills"),
    "--agents",
    join(root, "plugin/agents"),
    "--namespace",
    "jig",
    "--fail-soft",
  ]);
  return Math.max(chain, discovery);
}
if (import.meta.main) cli(() => checkContextBudget(process.argv[2]));
