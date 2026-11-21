#!/usr/bin/env bun
import { fail, runMain } from "../../../shared/cli.ts";
import { derivedEntries } from "./conflict-map.ts";
import {
  catalogGeneratedEntries,
  type GeneratedEntry,
  regenerateFor,
} from "./lib/classify.ts";
import type { MigrationPlan } from "./lib/migration-plan.ts";
import { topLevel } from "./lib/git.ts";
import { migrationPlans } from "./lib/migration-plan.ts";
import { currentSnapshot } from "./lib/snapshot.ts";

function commandsFor(plan: MigrationPlan, entries: readonly GeneratedEntry[]) {
  const { group, regenerate } = plan;
  if (group.command !== null || plan.moves.length > 0) return {};
  return Object.fromEntries(
    regenerate.map((path) => [
      path,
      regenerateFor(path, entries)?.regenerate ?? null,
    ]),
  );
}

async function main(): Promise<number> {
  if (process.argv.length !== 2) fail(2, "Usage: bun migration-plan.ts");
  const root = topLevel();
  if (root === null) fail(2, "migration-plan: not inside a git work tree");
  const { snapshot } = currentSnapshot("migration-plan", root);
  const plans = migrationPlans(root, snapshot);
  const entries = derivedEntries(catalogGeneratedEntries());
  console.log(
    JSON.stringify(
      plans.map((plan) => {
        const { group, integration, moves, remove, regenerate, problems } =
          plan;
        return {
          ...group,
          integration,
          moves,
          remove,
          regenerate,
          fallback: commandsFor(plan, entries),
          problems,
        };
      }),
      null,
      2,
    ),
  );
  return plans.some(({ problems }) => problems.length > 0) ? 1 : 0;
}

if (import.meta.main) runMain("migration-plan", main);
