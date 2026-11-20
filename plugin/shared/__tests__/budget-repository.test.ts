import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { ledgerReport, recordCall } from "../outbound/ledger.ts";
import { BUDGET_MIGRATIONS } from "../outbound/schema.ts";
import { closeDatabase, openDatabase } from "../records/db.ts";
import { currentMs } from "../time.ts";

const roots: string[] = [];
const paths: string[] = [];
afterEach(() => {
  for (const p of paths.splice(0)) closeDatabase(p);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const jig = resolve(import.meta.dir, "../../jig.ts");
const ledger = resolve(import.meta.dir, "../outbound/ledger.ts");
const hour = 3_600_000;

function ledgerPath(): string {
  const root = mkdtempSync(join(tmpdir(), "jig-budget-repository-"));
  roots.push(root);
  const path = join(root, "budget.sqlite");
  paths.push(path);
  return path;
}

/** `jig budget` with `args` over the ledger at `path`, in a child process; its standard output. */
function budget(path: string, args: string[]): string {
  // The script is fixed text; the values reach it through the environment.
  const script =
    "const {main} = await import(process.env.TEST_JIG); const {withLedgerPath} = await import(process.env.TEST_LEDGER); process.exit(await withLedgerPath(process.env.TEST_PATH, () => main(JSON.parse(process.env.TEST_ARGS))));";
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TEST_JIG: jig,
      TEST_LEDGER: ledger,
      TEST_PATH: path,
      TEST_ARGS: JSON.stringify(args),
    },
  });
  expectSpawnExit(result, 0);
  return result.stdout.toString();
}

interface RepositoryTotal {
  repository: string;
  requests: number;
  cost: number;
  unknownCost: number;
  notModified: number;
}

const byName = (totals: RepositoryTotal[], name: string) =>
  totals.find((t) => t.repository === name);

test("jig budget groups a week's spend by repository, spending on no known repository apart", () => {
  const path = ledgerPath();
  const now = currentMs();
  const call = {
    path,
    system: "github",
    credential: "github:test",
    operation: "GET /repos/{}/{}/pulls",
    caller: "tick:one",
    unit: "requests",
    requests: 1,
    estimated: false,
    durationMs: 1,
  };
  // Six days ago, three days ago and this hour, in two repositories and
  // on none; the same operation and caller, so one row holds all three.
  for (const at of [now - 6 * 24 * hour, now - 3 * 24 * hour, now]) {
    recordCall({ ...call, at, repository: "Owner/One", cost: 1 });
    recordCall({ ...call, at, repository: "owner/two", cost: 2 });
    recordCall({
      ...call,
      at,
      repository: "owner/two",
      cost: 0,
      notModified: 1,
    });
    recordCall({ ...call, at, cost: 5 });
    recordCall({ ...call, at, repository: null, cost: null });
  }
  const answer = JSON.parse(
    budget(path, ["budget", "--hours", "168", "--json"]),
  );
  const totals = answer.repositories as RepositoryTotal[];
  expect(totals.map((t) => t.repository).sort()).toEqual([
    "(no repository)",
    "owner/one",
    "owner/two",
  ]);
  expect(byName(totals, "owner/one")).toMatchObject({ requests: 3, cost: 3 });
  expect(byName(totals, "owner/two")).toMatchObject({
    requests: 6,
    cost: 6,
    notModified: 3,
  });
  expect(byName(totals, "(no repository)")).toMatchObject({
    requests: 6,
    cost: 15,
    unknownCost: 3,
    notModified: 0,
  });
  // The operation's totals are what they were before repositories were kept.
  expect(answer.operations).toEqual([
    expect.objectContaining({ requests: 15, cost: 24, unknownCost: 3 }),
  ]);
  // A day's window holds only this hour's share.
  const day = JSON.parse(budget(path, ["budget", "--json"]));
  expect(
    byName(day.repositories as RepositoryTotal[], "owner/two"),
  ).toMatchObject({ requests: 2, cost: 2 });
  const text = budget(path, ["budget", "--hours", "168"]);
  expect(text).toContain("By repository:");
  expect(text).toContain(
    "github github:test owner/two: 6 requests (3 answered 304 Not Modified), 6 requests",
  );
  expect(text).toContain(
    "github github:test (no repository): 6 requests, 15 requests, 3 unknown cost",
  );
});

test("a row a copy writes by position, with no repository part, reads under no repository", () => {
  const path = ledgerPath();
  const at = currentMs();
  recordCall({
    path,
    system: "github",
    credential: "github:test",
    operation: "pr view",
    caller: "skill:x",
    repository: "owner/one",
    cost: 1,
    estimated: true,
    durationMs: 1,
    at,
  });
  const opened = openDatabase({ path, migrations: BUDGET_MIGRATIONS });
  if (!opened.ok) throw new Error(opened.failure.reason);
  opened.value
    .query("INSERT INTO outbound_cost VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      Math.floor(at / hour) * hour,
      "github",
      "github:test",
      "pr list",
      "skill:x",
      "requests",
      2,
      2,
      0,
      1,
      1,
      "{}",
    );
  const rows = ledgerReport({ path, since: at - hour, until: at + 1 }).rows;
  expect(rows.find((r) => r.operation === "pr view")?.repositories).toEqual([
    {
      repository: "owner/one",
      requests: 1,
      cost: 1,
      unknownCost: 0,
      notModified: 0,
    },
  ]);
  expect(rows.find((r) => r.operation === "pr list")?.repositories).toEqual([]);
  const answer = JSON.parse(budget(path, ["budget", "--json"]));
  expect(
    byName(answer.repositories as RepositoryTotal[], "(no repository)"),
  ).toMatchObject({ requests: 2, cost: 2 });
});

test("a ledger an earlier copy created, with no repository table, reads unchanged", () => {
  const path = ledgerPath();
  const at = currentMs();
  // The schema before the repository table, written by position.
  const opened = openDatabase({
    path,
    migrations: BUDGET_MIGRATIONS.slice(0, -1),
  });
  if (!opened.ok) throw new Error(opened.failure.reason);
  opened.value
    .query("INSERT INTO outbound_cost VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      Math.floor(at / hour) * hour,
      "linear",
      "linear:test",
      "Queue",
      "tick:one",
      "points",
      3,
      30,
      1,
      0,
      12,
      JSON.stringify({ unreachable: 1 }),
    );
  closeDatabase(path);
  const rows = ledgerReport({ path, since: at - hour, until: at + 1 }).rows;
  expect(rows).toEqual([
    expect.objectContaining({
      operation: "Queue",
      requests: 3,
      cost: 30,
      unknownCost: 1,
      durationMs: 12,
      failures: { unreachable: 1 },
      repositories: [],
    }),
  ]);
  const answer = JSON.parse(budget(path, ["budget", "--json"]));
  expect(answer.operations).toEqual([
    expect.objectContaining({ operation: "Queue", requests: 3, cost: 30 }),
  ]);
  expect(answer.repositories).toEqual([
    expect.objectContaining({
      repository: "(no repository)",
      requests: 3,
      cost: 30,
      unknownCost: 1,
    }),
  ]);
});
