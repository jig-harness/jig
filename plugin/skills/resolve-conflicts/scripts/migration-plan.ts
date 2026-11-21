#!/usr/bin/env bun
import { fail, runMain } from "../../../shared/cli.ts";
import { topLevel } from "./lib/git.ts";
import { migrationPlans } from "./lib/migration-plan.ts";
import { currentSnapshot } from "./lib/snapshot.ts";

async function main(): Promise<number> {
  if (process.argv.length !== 2) fail(2, "Usage: bun migration-plan.ts");
  const root = topLevel();
  if (root === null) fail(2, "migration-plan: not inside a git work tree");
  const { snapshot } = currentSnapshot("migration-plan", root);
  const plans = migrationPlans(root, snapshot);
  console.log(
    JSON.stringify(
      plans.map(
        ({ group, integration, moves, remove, regenerate, problems }) => ({
          ...group,
          integration,
          moves,
          remove,
          regenerate,
          problems,
        }),
      ),
      null,
      2,
    ),
  );
  return plans.some(({ problems }) => problems.length > 0) ? 1 : 0;
}

if (import.meta.main) runMain("migration-plan", main);
