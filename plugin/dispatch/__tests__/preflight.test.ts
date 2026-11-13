/**
 * The tracker preflight. Before a tick launches a stage that touches the
 * tracker, it asks whether each account it could bill reaches the
 * repository's tracker, in that account's environment and the repository's
 * checkout, once per tick and account. An account that does not is held,
 * with one need of the host's for the repository and account, act
 * Authorize, whatever number of follow-ups it holds; a later answer that
 * passes clears the need and the follow-ups start. `preflight: []` turns it
 * off. The probe itself (`run.ts tracker`) reads the tracker through its
 * port, as a pass would.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import {
  type MachineAccount,
  readMachineConfig,
} from "../lib/machine-config.ts";
import {
  HOST_NEED_REPO,
  heldAccounts,
  newPreflight,
} from "../lib/preflight.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  assignedIssue,
  mergedPr,
  SLUG,
  type World,
  world,
} from "./fixtures.ts";
import { FOLLOWUP_CONFIG } from "./followup-fixtures.ts";
import { account, machineFile } from "./launch-fixtures.ts";
import { applyTick, claudeRuns, withOrigin } from "./pickup-fixtures.ts";

/** A probe in place of `run.ts tracker`: it logs each run and answers from `tracker-answers.json`, by the account's configuration directory. */
const FAKE_PROBE = `const fs = require("node:fs");
const path = require("node:path");
const F = process.env.DISPATCH_FAKE_DIR;
const input = fs.readFileSync(0, "utf8");
const dir = process.env.CLAUDE_CONFIG_DIR ?? "";
fs.appendFileSync(F + "/tracker-probes.jsonl", JSON.stringify({ argv: process.argv.slice(2), configDir: dir, cwd: process.cwd(), values: JSON.parse(input) }) + "\\n");
const file = F + "/tracker-answers.json";
const answers = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const answer = answers[path.basename(dir)] ?? { ok: true };
// A line of its own before the answer, as a client's notice would be; an answer given as text is printed as it is.
process.stdout.write("reading the tracker\\n" + (typeof answer === "string" ? answer : JSON.stringify(answer)) + "\\n");
`;

const KEYCHAIN = "the keychain is waiting for an approval";

interface ProbeRun {
  argv: string[];
  configDir: string;
  cwd: string;
  values: Record<string, unknown>;
}

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

/** PRs #9 and #10 merged, each with its workspace; `followup` enabled from before the merges on `accounts`, the fake probe in place. */
function fixture(names: string[], extra: Record<string, unknown> = {}): World {
  const w = world();
  current = w;
  w.setConfig(FOLLOWUP_CONFIG);
  withOrigin(w);
  w.setPrs("merged", [
    mergedPr(9, "feature/9-done", "2026-10-31T12:00:00Z"),
    mergedPr(10, "feature/10-done", "2026-10-31T13:00:00Z"),
  ]);
  const rows = [9, 10].map((pr) => {
    const path = join(w.root, `ws-${pr}`);
    mkdirSync(path, { recursive: true });
    w.setComments(pr, []);
    return { branch: `feature/${pr}-done`, linkedPR: pr, path };
  });
  w.setWorkspaces(rows);
  machineFile(
    w,
    names.map((name) => account(w, name, `${name}@example.com`)),
    extra,
    ["followup"],
    { followup_since: "2026-10-30T00:00:00Z" },
  );
  writeFileSync(join(w.root, "fake-tracker-probe.js"), FAKE_PROBE);
  w.env.JIG_DISPATCH_TRACKER_PROBE = join(w.root, "fake-tracker-probe.js");
  return w;
}

/** Each account's answer, by name; an account not named passes. */
function answers(w: World, byAccount: Record<string, string | null>): void {
  writeFileSync(
    join(w.dir, "tracker-answers.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(byAccount).map(([name, reason]) => [
          `config-${name}`,
          reason === null ? { ok: true } : { ok: false, reason },
        ]),
      ),
    ),
  );
}

function probes(w: World): ProbeRun[] {
  const path = join(w.dir, "tracker-probes.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as ProbeRun)
    : [];
}

async function line(w: World): Promise<LineSnapshot> {
  const read = await w.dispatch(["line", "--json"]);
  expectSpawnExit(read, 0);
  return (JSON.parse(read.stdout) as { value: { line: LineSnapshot } }).value
    .line;
}

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];

describe("the tracker preflight", () => {
  it("holds the follow-ups of an account that cannot reach the tracker under one host need, and a passing answer clears it", async () => {
    const w = fixture(["a"]);
    answers(w, { a: KEYCHAIN });

    const held = await applyTick(w, false);
    expect(launches(held)).toEqual([
      expect.objectContaining({
        target: "PR #9",
        outcome: "waits",
        detail: `the tracker preflight holds it on a (${KEYCHAIN})`,
      }),
      expect.objectContaining({
        target: "PR #10",
        outcome: "waits",
        detail: `the tracker preflight holds it on a (${KEYCHAIN})`,
      }),
    ]);
    expect(held.repos[0]?.preflight).toEqual([
      {
        probe: "tracker",
        account: "a",
        reason: KEYCHAIN,
        stages: ["followup"],
      },
    ]);
    expect(claudeRuns(w)).toEqual([]);
    const needs = (await line(w)).needs;
    // One need of the host's for the repository and the account, never one per follow-up.
    expect(needs).toEqual([
      expect.objectContaining({
        cause: "tracker-unreachable",
        act: "Authorize",
        repo: HOST_NEED_REPO,
        target: "account a",
        pr: null,
        item: null,
        stage: "followup",
        reason: expect.stringContaining(`${SLUG} are held: ${KEYCHAIN}`),
      }),
    ]);

    answers(w, { a: null });
    const cleared = await applyTick(w, false);
    expect(launches(cleared).map((l) => [l.target, l.outcome])).toEqual([
      ["PR #9", "launched"],
      ["PR #10", "launched"],
    ]);
    expect(cleared.repos[0]?.preflight).toBeUndefined();
    expect(
      (await line(w)).needs.filter((n) => n.cause === "tracker-unreachable"),
    ).toEqual([]);
  });

  it("asks each account once per tick, in its own environment and the repository's checkout", async () => {
    const w = fixture(["a", "b"]);
    answers(w, { a: KEYCHAIN, b: "the connection lapsed" });

    const first = await applyTick(w, false);
    expect(launches(first).map((l) => [l.target, l.outcome])).toEqual([
      ["PR #9", "waits"],
      ["PR #10", "waits"],
    ]);
    const runs = probes(w);
    // Two follow-ups held on both accounts, and each account asked once.
    expect(runs.map((r) => r.configDir).sort()).toEqual([
      join(w.root, "config-a"),
      join(w.root, "config-b"),
    ]);
    for (const run of runs) {
      expect(run.cwd).toBe(resolve(w.repo));
      expect(run.argv.slice(0, 2)).toEqual(["tracker", SLUG]);
      expect(run.values.issue_tracker).toMatchObject({ adapter: "github" });
    }
    expect(first.repos[0]?.preflight?.map((h) => h.account)).toEqual([
      "a",
      "b",
    ]);
    const needs = (await line(w)).needs;
    expect(needs.map((n) => [n.cause, n.target])).toEqual([
      ["tracker-unreachable", "account a"],
      ["tracker-unreachable", "account b"],
    ]);

    // The next tick asks again, once per account.
    await applyTick(w, false);
    expect(probes(w)).toHaveLength(4);
  });

  it("starts the follow-up on an account that reaches the tracker, and still names the account that does not", async () => {
    const w = fixture(["a", "b"]);
    answers(w, { a: KEYCHAIN });

    const tick = await applyTick(w, false);
    expect(launches(tick).map((l) => [l.outcome, l.account])).toEqual([
      ["launched", "b"],
      ["launched", "b"],
    ]);
    expect((await line(w)).needs.map((n) => [n.cause, n.target])).toEqual([
      ["tracker-unreachable", "account a"],
    ]);
  });

  it("holds a pickup the same way", async () => {
    const w = world();
    current = w;
    w.setConfig(`${FOLLOWUP_CONFIG}  identity: factory-bot\n`);
    w.setIssues([assignedIssue(12, "factory-bot", [])]);
    w.setAssigner(12, "maintainer", "WRITE");
    withOrigin(w);
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["pickup"]);
    writeFileSync(join(w.root, "fake-tracker-probe.js"), FAKE_PROBE);
    w.env.JIG_DISPATCH_TRACKER_PROBE = join(w.root, "fake-tracker-probe.js");
    answers(w, { a: KEYCHAIN });

    const tick = await applyTick(w, false);
    expect(launches(tick)).toEqual([
      expect.objectContaining({
        target: "#12",
        outcome: "waits",
        detail: `the tracker preflight holds it on a (${KEYCHAIN})`,
      }),
    ]);
    expect(tick.repos[0]?.preflight).toEqual([
      { probe: "tracker", account: "a", reason: KEYCHAIN, stages: ["pickup"] },
    ]);
    expect(claudeRuns(w)).toEqual([]);
  });

  it("holds an account whose probe printed no answer, with what it printed", async () => {
    const w = fixture(["a"]);
    writeFileSync(
      join(w.dir, "tracker-answers.json"),
      JSON.stringify({ "config-a": "a keychain prompt went unanswered" }),
    );

    const tick = await applyTick(w, false);
    expect(launches(tick).map((l) => l.outcome)).toEqual(["waits", "waits"]);
    expect(tick.repos[0]?.preflight).toEqual([
      expect.objectContaining({
        account: "a",
        reason: expect.stringContaining("a keychain prompt went unanswered"),
      }),
    ]);
  });

  it("holds nothing on a rate-limited answer", async () => {
    const w = fixture(["a"]);
    writeFileSync(
      join(w.dir, "tracker-answers.json"),
      JSON.stringify({
        "config-a": {
          ok: false,
          kind: "transient",
          reason: "linear's rate limit for this credential is spent",
        },
      }),
    );

    const limited = await applyTick(w, false);
    expect(launches(limited).map((l) => [l.target, l.outcome])).toEqual([
      ["PR #9", "launched"],
      ["PR #10", "launched"],
    ]);
    expect(limited.repos[0]?.preflight).toBeUndefined();
    expect(
      (await line(w)).needs.filter((n) => n.cause === "tracker-unreachable"),
    ).toEqual([]);
  });

  it("holds nothing on a configuration that opens no tracker", async () => {
    const w = fixture(["a"]);
    writeFileSync(
      join(w.dir, "tracker-answers.json"),
      JSON.stringify({
        "config-a": {
          ok: false,
          kind: "config",
          reason: "issue_tracker.team names ENG, which is no Jira project",
        },
      }),
    );

    const tick = await applyTick(w, false);
    expect(launches(tick).map((l) => l.outcome)).toEqual([
      "launched",
      "launched",
    ]);
    expect(tick.repos[0]?.preflight).toBeUndefined();
  });

  it("asks nothing with `preflight: []`", async () => {
    const w = fixture(["a"], { preflight: [] });
    answers(w, { a: KEYCHAIN });

    const tick = await applyTick(w, false);
    expect(launches(tick).map((l) => l.outcome)).toEqual([
      "launched",
      "launched",
    ]);
    expect(probes(w)).toEqual([]);
  });
});

describe("the machine file's preflight key", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });

  function read(body: string) {
    const dir = mkdtempSync(join(tmpdir(), "jig-preflight-config-"));
    dirs.push(dir);
    writeFileSync(join(dir, "dispatch.yaml"), body);
    return readMachineConfig(join(dir, "dispatch.yaml"));
  }

  it("runs the tracker check by default, none with [], and refuses an unknown or repeated check", () => {
    expect(read("")).toMatchObject({
      ok: true,
      value: { preflight: ["tracker"] },
    });
    expect(read("preflight: []\n")).toMatchObject({
      ok: true,
      value: { preflight: [] },
    });
    for (const body of [
      "preflight: [forge]\n",
      "preflight: [tracker, tracker]\n",
      "preflight: tracker\n",
    ])
      expect(read(body)).toMatchObject({
        ok: false,
        failure: {
          code: "invalid",
          reason: expect.stringContaining(
            "preflight must list distinct checks",
          ),
        },
      });
  });
});

describe("run.ts tracker", () => {
  const RUN_TS = resolve(import.meta.dir, "../run.ts");
  const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");
  const GITHUB = JSON.stringify({
    issue_tracker: { adapter: "github", github: { repository: SLUG } },
  });
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });

  /**
   * The probe against a tracker that answers every request with `body` and
   * `status`, handed `input`; with `closed`, against a port nothing answers.
   */
  async function probe(
    body: Record<string, unknown>,
    options: { status?: number; input?: string; closed?: boolean } = {},
  ) {
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const { query } = (await request.json()) as { query: string };
        requests.push(/(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "");
        return Response.json(body, { status: options.status ?? 200 });
      },
    });
    const port = server.port;
    if (options.closed === true) server.stop(true);
    const cwd = mkdtempSync(join(tmpdir(), "jig-tracker-probe-"));
    dirs.push(cwd);
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          `--config=${BUNFIG}`,
          RUN_TS,
          "tracker",
          SLUG,
          "10000",
        ],
        {
          cwd,
          stdin: new Blob([options.input ?? GITHUB]),
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: cwd,
            JIG_HOME: join(cwd, ".jig"),
            JIG_USER_LAYER: "off",
            JIG_GITHUB_GRAPHQL_URL: `http://127.0.0.1:${port}/graphql`,
            GH_TOKEN: "test-token",
          },
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expectSpawnExit({ exitCode, stdout, stderr }, 0);
      return { answer: JSON.parse(stdout) as unknown, requests };
    } finally {
      server.stop(true);
    }
  }

  it("answers ok when the tracker reads the repository", async () => {
    const { answer, requests } = await probe({
      data: { repository: { id: "R_repo" } },
    });
    expect(answer).toEqual({ ok: true });
    expect(requests).toEqual(["TrackerRepository"]);
  });

  it("answers unreachable with the tracker's refusal of the credential", async () => {
    const { answer } = await probe({
      errors: [{ message: "Bad credentials" }],
    });
    expect(answer).toEqual({
      ok: false,
      kind: "unreachable",
      reason: expect.stringContaining("Bad credentials"),
    });
  });

  it("answers transient for a rate limit, a server error and the network", async () => {
    const limited = await probe({
      errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
    });
    expect(limited.answer).toMatchObject({ ok: false, kind: "transient" });
    const server = await probe({ message: "Bad gateway" }, { status: 502 });
    expect(server.answer).toMatchObject({
      ok: false,
      kind: "transient",
      reason: expect.stringContaining("HTTP 502"),
    });
    const network = await probe({}, { closed: true });
    expect(network.answer).toMatchObject({
      ok: false,
      kind: "transient",
      reason: expect.stringContaining("unreachable"),
    });
  });

  it("answers config for a configuration that opens no tracker, or an input that does not read", async () => {
    const unknown = await probe(
      {},
      { input: JSON.stringify({ issue_tracker: { adapter: "nowhere" } }) },
    );
    expect(unknown.answer).toMatchObject({
      ok: false,
      kind: "config",
      reason: expect.stringContaining("the tracker cannot be opened"),
    });
    const garbled = await probe({}, { input: "{not json" });
    expect(garbled.answer).toMatchObject({
      ok: false,
      kind: "config",
      reason: expect.stringContaining(
        "the configuration on the input did not read",
      ),
    });
  });
});

describe("heldAccounts", () => {
  const names = ["a", "b", "c", "d", "e", "f"];
  const accounts = names.map((name) => ({ name }) as never as MachineAccount);
  const target = {
    slug: SLUG,
    path: "/x",
    tracker: "github:x/y",
    values: {},
    report: { preflight: undefined } as never,
  };
  const down = { ok: false, kind: "unreachable", reason: "down" } as const;

  it("keeps the accounts' order whatever order the probes finish in", async () => {
    const pf = newPreflight(
      {},
      (acct) =>
        new Promise((r) =>
          setTimeout(() => r(down), acct.name === "a" ? 30 : 1),
        ),
    );
    pf.targets.set(SLUG, target);
    const held = await heldAccounts(pf, SLUG, "pickup", accounts, 1);
    expect([...held.keys()]).toEqual(names);
  });

  it("holds the accounts not yet asked once the tick has no room", async () => {
    const asked: string[] = [];
    const pf = newPreflight({}, async (acct) => {
      asked.push(acct.name);
      return down;
    });
    pf.targets.set(SLUG, target);
    const held = await heldAccounts(pf, SLUG, "pickup", accounts, 1, () =>
      asked.length >= 4 ? "no room" : null,
    );
    expect(asked).toHaveLength(4);
    expect(held.get("f")).toBe("no room");
    expect(held.size).toBe(6);
  });
});
