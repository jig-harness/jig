import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function refused(migrations: string): boolean {
  const dir = scratchRepo({
    ".config/jig.yaml": `resolve_conflicts:\n  sequenced_migrations: ${migrations}\n`,
  });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  const report = JSON.parse(run.out) as { findings: { id: string }[] };
  return report.findings.some(
    (finding) => finding.id === "rejected:resolve-conflicts",
  );
}

test("resolve-conflicts validates sequenced migration runtime contracts", () => {
  expect(
    refused(
      "[{directory: db, journal: db/journal.json, snapshots: [db/meta/snapshot.json], command: bun run rebuild}]",
    ),
  ).toBe(true);
  expect(
    refused(
      '[{directory: db, journal: db/journal.json, snapshots: ["db/meta/{sequence}.json"], command: bun run rebuild}]',
    ),
  ).toBe(false);
});
