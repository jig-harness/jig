/**
 * A Linear call with no key and no logged-in client spends nothing under any
 * credential identity: `jig budget` lists it under "no Linear key
 * configured" with its callers. A logged-in client's calls stay under the
 * client's identity, which `jig budget` labels as the client's own login.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { cliTransport } from "../../skills/do-item/scripts/lib/tracker/linear-transport.ts";
import { credentialKey } from "../outbound/budget.ts";
import {
  ledgerReport,
  recordCall,
  withCaller,
  withLedgerPath,
} from "../outbound/ledger.ts";
import {
  forgetMissingCredentials,
  NO_CREDENTIAL,
} from "../outbound/missing-credential.ts";

const roots: string[] = [];
afterEach(() => {
  // What a test's transport noted would refuse the next test's calls.
  forgetMissingCredentials();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const jig = resolve(import.meta.dir, "../../jig.ts");
const ledger = resolve(import.meta.dir, "../outbound/ledger.ts");

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

test("a keyless run spends under no credential and is listed under no Linear key configured with its callers", async () => {
  const root = mkdtempSync(join(tmpdir(), "jig-budget-keyless-"));
  roots.push(root);
  const path = join(root, "budget.sqlite");
  const bin = join(root, "linear");
  writeFakeProgram(
    bin,
    `#!/usr/bin/env bun
require("node:fs").appendFileSync(${JSON.stringify(join(root, "calls.log"))}, "call\\n");
process.stderr.write("✗ API request failed: No API key configured\\n");
process.exit(1);
`,
  );
  const transport = cliTransport(bin);
  await withLedgerPath(path, () =>
    withCaller("tick:keyless-run", async () => {
      for (const query of [
        "query TrackerTeam { a }",
        "query TrackerIssue { b }",
      ])
        await expect(transport(query, {})).rejects.toThrow(
          "no Linear key configured",
        );
    }),
  );
  // The client is asked once: the second call is refused before it leaves.
  expect(readFileSync(join(root, "calls.log"), "utf8")).toBe("call\n");
  const answer = JSON.parse(budget(path, ["budget", "--json"]));
  const client = credentialKey("linear", `cli:${bin}`);
  for (const row of [...answer.operations, ...answer.callers]) {
    expect(row.credential).not.toBe(client);
    expect(row.requests).toBe(0);
    expect(row.cost).toBe(0);
    expect(row.unknownCost).toBe(0);
  }
  // The raw rows keep what the report's groups leave out: the keyless rows spent nothing.
  const raw = ledgerReport({ path, since: 0, until: Date.now() + 3_600_000 });
  const keyless = raw.rows.filter((r) => r.credential === NO_CREDENTIAL);
  expect(keyless.length).toBeGreaterThan(0);
  for (const row of keyless) {
    expect(row.requests).toBe(0);
    expect(row.cost).toBe(0);
    expect(row.unknownCost).toBe(0);
  }
  // Keyless calls are listed apart, never as spending of a repository.
  expect(answer.repositories).toEqual([]);
  expect(answer.noCredential).toEqual([
    {
      system: "linear",
      label: "no Linear key configured",
      calls: 2,
      callers: ["tick:keyless-run"],
    },
  ]);
  const text = budget(path, ["budget"]);
  expect(text).toContain("no Linear key configured: 2 calls");
  expect(text).toContain("tick:keyless-run");
  expect(text).not.toContain("(no repository)");
  expect(text).not.toContain(client);
});

test("a logged-in client's calls are labelled as the client's own login, never as a bare credential hash", () => {
  const root = mkdtempSync(join(tmpdir(), "jig-budget-client-"));
  roots.push(root);
  const path = join(root, "budget.sqlite");
  // The identity the client transport records a logged-in client's calls under.
  const client = credentialKey("linear", "cli:linear");
  recordCall({
    path,
    system: "linear",
    credential: client,
    operation: "TrackerTeam",
    caller: "skill:pickup",
    unit: "points",
    requests: 1,
    cost: null,
    durationMs: 5,
  });
  const answer = JSON.parse(budget(path, ["budget", "--json"]));
  expect(answer.operations[0]).toMatchObject({
    credential: client,
    credentialLabel: "the `linear` client's own login",
  });
  expect(answer.noCredential).toEqual([]);
  const text = budget(path, ["budget"]);
  expect(text).toContain("linear the `linear` client's own login TrackerTeam");
  expect(text).not.toContain(client);
});

test("a caller that waited for the first call leaves no abort listener on its signal", async () => {
  const { getEventListeners } = await import("node:events");
  const { throughCredential } = await import(
    "../outbound/missing-credential.ts"
  );
  const controller = new AbortController();
  const gate = Promise.withResolvers<void>();
  const refuse = () => Promise.reject(new Error("refused"));
  const firstCall = throughCredential(
    "linear:leak-test",
    async () => {
      await gate.promise;
      return 1;
    },
    refuse,
  );
  const waiter = throughCredential(
    "linear:leak-test",
    async () => 2,
    refuse,
    () => false,
    controller.signal,
  );
  await Promise.resolve();
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
  gate.resolve();
  await Promise.all([firstCall, waiter]);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});
