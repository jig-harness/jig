/**
 * `drives.ts --report`: the workspaces the dispatcher launched into since
 * the report's time, found by the dispatched mark on their launch records,
 * never by their names, each with the name it carries now as the session
 * runtime (a fake `orca`) shows it. A workspace a skill renamed is still
 * listed; a record from before the report's time, or one with no mark, is
 * not.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { closeStateDb } from "../../../dispatch/lib/state.ts";
import {
  type LaunchRecord,
  writeRecord,
} from "../../../dispatch/lib/launches.ts";
import {
  fakeForge,
  type Forge,
  runIn,
  SCRIPTS,
} from "./provisional-fixtures.ts";

const SLUG = "example-org/example-repo";
const ID = "20261102T010000Z-aaaaaaaa";
const MARK = `⚙ dispatched · rearm #7 · launch ${ID}`;

/** A fake `orca`: one repository, and the workspaces `orca-ps.json` lists. */
const FAKE_ORCA = `#!/usr/bin/env bun
const fs = require("node:fs");
const F = process.env.PROV_FAKE_DIR;
const args = process.argv.slice(2);
const answer = (result) => { process.stdout.write(JSON.stringify({ id: "x", ok: true, result })); process.exit(0); };
if (args[0] === "repo" && args[1] === "list")
  answer({ repos: [{ id: "repo-1", path: "/repos/example", gitRemoteIdentity: { canonicalKey: "github.com/${SLUG}" } }] });
if (args[0] === "worktree" && args[1] === "ps")
  answer({ worktrees: JSON.parse(fs.readFileSync(F + "/orca-ps.json", "utf8")), hostScope: { hostIds: ["local"], omittedHostIds: [] }, totalCount: 1, truncated: false });
process.stdout.write(JSON.stringify({ ok: false, error: { code: "unhandled" } }));
process.exit(1);
`;

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) closeStateDb(root);
  roots = [];
});

function record(fields: Partial<LaunchRecord>): LaunchRecord {
  return {
    version: 1,
    id: ID,
    token: "t",
    action: "rearm",
    repo: SLUG,
    repoPath: "/repos/example",
    pr: 7,
    item: null,
    account: "a",
    vendor: "claude",
    configDir: "/config-a",
    wallBackoffMs: 3_600_000,
    replaces: null,
    facts: "",
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    workspace: { id: "repo-1::/ws/7", path: "/ws/7" },
    attempts: [{ at: new Date().toISOString(), outcome: "sent", detail: "" }],
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
    mark: MARK,
    ...fields,
  };
}

/** A night with one dispatched re-arm, whose workspace a skill renamed, beside records the report leaves out. */
function setUp(): { forge: Forge; orca: string } {
  const forge = fakeForge("");
  forge.write("login", "drive-bot");
  forge.write("search.json", { items: [] });
  const root = join(
    forge.env.HOME as string,
    ".local",
    "state",
    "jig",
    "dispatch",
  );
  roots.push(root);
  writeRecord(record({}), root);
  // Before the report's time, and one written before records kept the mark.
  writeRecord(
    record({
      id: "20261030T010000Z-bbbbbbbb",
      createdAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
      mark: "⚙ dispatched · rearm #7 · launch 20261030T010000Z-bbbbbbbb",
    }),
    root,
  );
  writeRecord(record({ id: "20261102T020000Z-cccccccc", mark: null }), root);
  forge.write("orca-ps.json", [
    {
      worktreeId: "repo-1::/ws/7",
      repoId: "repo-1",
      path: "/ws/7",
      branch: "refs/heads/feature/7-retries",
      displayName: "Retry budget",
      comment: `Keep three retries\n${MARK}`,
      unread: false,
      unverifiableTerminalCount: 0,
      agents: [],
    },
  ]);
  const orca = join(forge.dir, "..", "bin", "orca-fake");
  writeFakeProgram(orca, FAKE_ORCA);
  return { forge, orca };
}

const report = (forge: Forge, orca: string, args: string[]) =>
  runIn(forge, join(SCRIPTS, "drives.ts"), ["--report", ...args], {
    env: { ORCA_CLI_COMMAND: orca },
  });

describe("drives.ts --report: the dispatched workspaces", () => {
  it("lists a workspace renamed after its launch as dispatched, from its launch record and comment", async () => {
    const { forge, orca } = setUp();
    const json = await report(forge, orca, ["--json"]);
    expectSpawnExit(json, 0);
    const out = JSON.parse(json.stdout);
    expect(out.unread).toEqual([]);
    expect(out.dispatchedWorkspaces).toEqual([
      expect.objectContaining({
        repo: SLUG,
        record: ID,
        mark: MARK,
        path: "/ws/7",
        name: "Retry budget",
        marked: true,
        launch: "started",
      }),
    ]);
    const text = await report(forge, orca, ["--since", "12h"]);
    expectSpawnExit(text, 0);
    expect(text.stdout).toContain(
      `${SLUG} ${MARK}: now named "Retry budget" (/ws/7)`,
    );
  });

  it("says why a workspace's name is unknown when the runtime no longer lists it", async () => {
    const { forge, orca } = setUp();
    forge.write("orca-ps.json", []);
    const r = await report(forge, orca, ["--json"]);
    expectSpawnExit(r, 0);
    const out = JSON.parse(r.stdout);
    expect(out.dispatchedWorkspaces).toEqual([
      expect.objectContaining({
        record: ID,
        name: null,
        note: "orca no longer lists it",
      }),
    ]);
    expect(out.unread).toEqual([]);
  });
});
