/**
 * `tracker.ts issue-states`: the state of each item key, as M4's scheduled
 * deferral check reads it. The decision (which categories are closed, a
 * missing issue, a lookup that fails) is tested against a fake tracker; the
 * command runs against a fake `linear` client on PATH.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import type { PoolIssue } from "../scripts/lib/tracker/port.ts";
import { itemStates, parseItemKeys, UsageError } from "../scripts/tracker.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "tracker.ts");
const OVERLAY = join(import.meta.dir, "fixtures", "overlay.yaml");

const issue = (type: string) =>
  ({ state: { id: "s", name: "n", type } }) as PoolIssue;

const lookup = (answers: Record<string, string | null>) => ({
  poolIssue: async (key: string) => {
    const answer = answers[key];
    if (answer === undefined) throw new Error(`unexpected lookup ${key}`);
    return answer === null ? null : issue(answer);
  },
});

describe("parseItemKeys", () => {
  it("reads one key per line, once each and sorted, skipping blank lines", () => {
    expect(parseItemKeys("ENG-2\n\n ENG-1 \r\nENG-2\n")).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
    expect(parseItemKeys("")).toEqual([]);
  });

  it.each(["ENG", "ENG-", "-12", "ENG-1 ENG-2", "ENG-1;rm", "--flag"])(
    "refuses %p as a key",
    (text) => {
      expect(() => parseItemKeys(text)).toThrow(UsageError);
    },
  );
});

describe("itemStates", () => {
  it("maps each state category to open or closed and a missing issue to not_found", async () => {
    const states = await itemStates(
      lookup({
        "ENG-1": "completed",
        "ENG-2": "canceled",
        "ENG-3": "duplicate",
        "ENG-4": "started",
        "ENG-5": "unstarted",
        "ENG-6": "backlog",
        "ENG-7": "triage",
        "ENG-8": null,
      }),
      ["ENG-8", "ENG-7", "ENG-6", "ENG-5", "ENG-4", "ENG-3", "ENG-2", "ENG-1"],
    );
    expect(states).toEqual({
      "ENG-1": "closed",
      "ENG-2": "closed",
      "ENG-3": "closed",
      "ENG-4": "open",
      "ENG-5": "open",
      "ENG-6": "open",
      "ENG-7": "open",
      "ENG-8": "not_found",
    });
  });

  it("fails the whole answer when a lookup fails or reports no state category", async () => {
    await expect(
      itemStates(lookup({ "ENG-1": "started" }), ["ENG-1", "ENG-2"]),
    ).rejects.toThrow("unexpected lookup ENG-2");
    await expect(
      itemStates(lookup({ "ENG-1": "" }), ["ENG-1"]),
    ).rejects.toThrow("no state category");
  });

  it.each([" ", "unknown", "complete", "Started"])(
    "fails the whole answer on the state category %p, which is neither open nor closed",
    async (type) => {
      await expect(
        itemStates(lookup({ "ENG-1": "started", "ENG-2": type }), [
          "ENG-1",
          "ENG-2",
        ]),
      ).rejects.toThrow("neither open nor closed");
    },
  );

  it("answers an empty list with an empty object without a lookup", async () => {
    expect(await itemStates(lookup({}), [])).toEqual({});
  });
});

describe("tracker.ts issue-states", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const node = (identifier: string, type: string) =>
    JSON.stringify({
      data: {
        issue: {
          identifier,
          title: "t",
          url: null,
          priority: 3,
          createdAt: "2026-09-01T00:00:00.000Z",
          state: { id: "s", name: "State", type },
          assignee: null,
          labels: { pageInfo: { hasNextPage: false }, nodes: [] },
          children: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      },
    });

  /** A fake `linear` client that answers a pool-issue query per item key and fails any other. */
  const stub = (answers: Record<string, string>) => {
    const branches = Object.entries(answers)
      .map(
        ([key, type], i) => `if [ '{"id":"${key}"}' = "$4" ]; then
  cat <<'JSON_EOF_${i}'
${node(key, type)}
JSON_EOF_${i}
  exit 0
fi`,
      )
      .join("\n");
    return `#!/bin/sh\n${branches}\necho "unexpected linear invocation: $*" >&2\nexit 3\n`;
  };

  const run = (
    args: string[],
    input: string,
    answers: Record<string, string> = {},
  ) => {
    const bin = mkdtempSync(join(tmpdir(), "do-item-issue-states-"));
    dirs.push(bin);
    writeFakeProgram(join(bin, "linear"), stub(answers));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (
        v !== undefined &&
        !k.startsWith("GIT_") &&
        k !== "LINEAR_API_KEY" &&
        k !== "LINEAR_API_TOKEN"
      )
        env[k] = v;
    env.JIG_OVERLAY = OVERLAY;
    env.PATH = `${bin}${delimiter}${process.env.PATH}`;
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      input,
      env,
    });
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it("prints the state of each item key read from stdin", () => {
    const r = run(["issue-states"], "ENG-2\nENG-1\n", {
      "ENG-1": "completed",
      "ENG-2": "started",
    });
    expectSpawnExit(r, 0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({
      "ENG-1": "closed",
      "ENG-2": "open",
    });
  });

  it("fails rather than print a partial answer when the tracker cannot be asked", () => {
    const r = run(["issue-states"], "ENG-1\nENG-9\n", {
      "ENG-1": "completed",
    });
    expectSpawnExit(r, 1);
    expect(r.stdout).toBe("");
  });

  it("prints an empty object for no keys and refuses a malformed key or an argument", () => {
    const none = run(["issue-states"], "\n");
    expectSpawnExit(none, 0);
    expect(JSON.parse(none.stdout)).toEqual({});
    expectSpawnExit(run(["issue-states"], "not a key\n"), 2);
    expectSpawnExit(run(["issue-states", "ENG-1"], ""), 2);
  });
});
