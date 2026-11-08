#!/usr/bin/env bun
/**
 * Serves one scenario through the real dashboard server, over a fresh temporary
 * state directory, with the clock held still.
 *
 * Usage:
 *   bun dashboard/serve-fixture.ts --scenario <id> [--port <n>]
 *
 * It prints the page's URL and runs until it is stopped.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, strictOptions } from "../lib/cli.ts";
import { serveDashboard } from "../plugin/dispatch/dashboard.ts";
import { writeLine } from "../plugin/dispatch/lib/line-store.ts";
import { insertRow } from "../plugin/dispatch/lib/log.ts";
import { closeStateDb, stateDb } from "../plugin/dispatch/lib/state.ts";
import { fixture, SCENARIOS, type ScenarioId } from "./fixtures.ts";

const USAGE =
  "usage: bun dashboard/serve-fixture.ts --scenario <id> [--port <n>]";

/** The token every fixture server takes. */
export const FIXTURE_TOKEN = "fixture-token";

/** A command line this script does not take. */
class FixtureUsageError extends Error {
  override name = "FixtureUsageError";
}

function isScenario(value: string | undefined): value is ScenarioId {
  return (SCENARIOS as readonly unknown[]).includes(value);
}

async function main(): Promise<number> {
  const { values } = strictOptions(
    {
      options: {
        scenario: { type: "string" },
        port: { type: "string" },
      },
    },
    USAGE,
  );
  if (!isScenario(values.scenario))
    throw new FixtureUsageError(
      `--scenario takes one of ${SCENARIOS.join(", ")}\n${USAGE}`,
    );
  const chosen = fixture(values.scenario);
  const root = mkdtempSync(join(tmpdir(), "dashboard-fixture-"));
  const db = stateDb(root);
  db.transaction(() => {
    for (const row of chosen.rows) insertRow(db, row);
  })();
  if (chosen.line !== null)
    writeLine(chosen.line, JSON.stringify({ runId: chosen.line.runId }), root);
  const fixed = Date.parse(chosen.now);
  const dashboard = serveDashboard({
    listen: { host: "127.0.0.1", port: null },
    port: values.port === undefined ? 0 : Number(values.port),
    root,
    token: FIXTURE_TOKEN,
    now: () => fixed,
    readPr: async () => null,
  });
  console.log(dashboard.url);
  await new Promise<void>((settle) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => settle());
  });
  dashboard.stop();
  closeStateDb(root);
  rmSync(root, { recursive: true, force: true });
  return 0;
}

if (import.meta.main) cli(main);
