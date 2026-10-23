/**
 * The GitHub store against a local fake of GitHub's GraphQL API: the
 * conformance suite, `check`, one issue per change with its title and
 * description as a view of the events, comments by people who cannot write
 * ignored, exhaustive and failing reads, retries, and a repository
 * reflecting into the store through its setting.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { run, tsArgv } from "../../../shared/proc.ts";
import { eventText, type ReflectionEvent } from "../scripts/lib/events.ts";
import { COMMENT_MARK, recordMarkdown } from "../scripts/lib/github/model.ts";
import { parseReflection } from "../scripts/lib/settings.ts";
import {
  EXIT,
  runStore,
  type StoreResult,
} from "../scripts/lib/store-client.ts";
import {
  runConformance,
  sampleDecision,
  sampleFinding,
} from "../scripts/store-contract.ts";
import { FakeGitHub } from "./github-fake.ts";
import { finding, Machine } from "./scratch.ts";

const GITHUB_STORE = join(import.meta.dir, "..", "scripts", "github-store.ts");
const REFLECT = join(import.meta.dir, "..", "scripts");

let dir: string;
let fake: FakeGitHub;
let env: Record<string, string>;

/** This process's environment without anything that points at GitHub. */
function cleanEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      key !== "GH_TOKEN" &&
      key !== "GITHUB_TOKEN" &&
      !key.startsWith("JIG_GITHUB_")
    )
      base[key] = value;
  return base;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "reflect-github-")));
  fake = new FakeGitHub();
  fake.addStoreLabel();
  env = fake.env({ ...cleanEnv(), JIG_HOME: join(dir, "jig-home") });
});
afterEach(() => {
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

const ID = (n: number): string =>
  `20261012T150405Z-${n.toString(16).padStart(16, "0")}`;

function command(repository = fake.repository): string[] {
  return tsArgv(GITHUB_STORE, ["--repository", repository]);
}

function store(
  op: Parameters<typeof runStore>[1],
  input = "",
  environment = env,
): Promise<StoreResult> {
  return runStore(command(), op, input, 60, environment);
}

function spawnResult(r: StoreResult) {
  return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
}

function jsonl(events: readonly ReflectionEvent[]): string {
  return `${events.map(eventText).join("\n")}\n`;
}

async function append(events: readonly ReflectionEvent[]) {
  const r = await store("append", jsonl(events));
  expectSpawnExit(spawnResult(r), 0, "append");
  return JSON.parse(r.stdout) as { stored: Array<{ id: string; ref: string }> };
}

async function listed(): Promise<string[]> {
  const r = await store("list");
  expectSpawnExit(spawnResult(r), 0, "list");
  return r.stdout.split("\n").filter((line) => line !== "");
}

async function checked(environment = env): Promise<Record<string, unknown>> {
  const r = await store("check", "", environment);
  expectSpawnExit(spawnResult(r), 0, "check");
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

/** A store comment holding `events`, as someone else might post it. */
function storeComment(events: readonly ReflectionEvent[]): string {
  return [
    COMMENT_MARK,
    ...events.map((e) => recordMarkdown(eventText(e))),
  ].join("\n\n");
}

describe("the GitHub store", () => {
  it("passes the conformance suite", async () => {
    const results = await runConformance(command(), 60, env);
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(results.length).toBeGreaterThan(10);
  }, 180_000);

  it("checks the credential, the repository, its Issues, the account's permission and the label", async () => {
    expect(await checked()).toEqual({ ok: true });

    const { GH_TOKEN: _, ...noToken } = env;
    const without = await checked(noToken);
    expect(without.ok).toBe(false);
    expect(String(without.fix)).toContain("gh auth login");
    const refused = await checked({ ...env, GH_TOKEN: "wrong" });
    expect(refused.ok).toBe(false);
    expect(String(refused.fix)).toContain("gh auth login");

    const unseen = await runStore(
      command("example/elsewhere"),
      "check",
      "",
      60,
      env,
    );
    expect(JSON.parse(unseen.stdout).reason).toContain("cannot see");

    fake.viewerPermission = "READ";
    expect(String((await checked()).reason)).toContain("cannot write");
    fake.viewerPermission = "WRITE";

    fake.hasIssuesEnabled = false;
    expect(String((await checked()).reason)).toContain("Issues turned off");
    fake.hasIssuesEnabled = true;

    fake.labels.delete("jig-reflection");
    const unlabelled = await checked();
    expect(unlabelled.ok).toBe(false);
    expect(String(unlabelled.fix)).toStartWith(
      `gh label create jig-reflection --repo ${fake.repository}`,
    );
    // Without the label, a listing would look empty: it is refused instead.
    expectSpawnExit(spawnResult(await store("list")), EXIT.failed, "list");
  });

  it("keeps one labelled issue per change, its events in one comment, and its title and description computed from them", async () => {
    const a = {
      ...sampleFinding(ID(1), "The setup step assumed a label @someone"),
      severity: "medium" as const,
    };
    const b = {
      ...sampleFinding(ID(2), "A second finding", "2026-10-13T09:00:00Z"),
      change: a.change,
      severity: "high" as const,
      class: "instruction-missing-precondition",
    };
    const receipt = await append([a, b]);
    expect(fake.issues).toHaveLength(1);
    const issue = fake.issues[0] as (typeof fake.issues)[number];
    expect([...issue.labels]).toEqual(["jig-reflection"]);
    expect(issue.comments).toHaveLength(1);
    const url = issue.comments[0]?.url ?? "";
    expect(receipt.stored.map((s) => s.ref)).toEqual([url, url]);
    expect(issue.title).toBe(
      `[example.invalid/store-contract] ${a.change.branch}: ${a.title}`,
    );
    expect(issue.body).toContain("| Status | Inbox |");
    expect(issue.body).toContain("| Severity | high |");
    // Prose mentions nobody; the record keeps the event byte for byte.
    expect(issue.comments[0]?.body).toContain("label @\u200bsomeone**");
    expect(await listed()).toEqual([eventText(a), eventText(b)]);

    await append([sampleDecision(ID(3), a.id, "not actionable")]);
    await append([sampleDecision(ID(4), b.id, "already fixed")]);
    expect(fake.issues).toHaveLength(1);
    expect(issue.comments).toHaveLength(3);
    expect(issue.body).toContain("| Status | Dismissed |");
  });

  it("ignores records in comments by people who cannot write, and diagnose reports them", async () => {
    const a = sampleFinding(ID(1), "first");
    await append([a]);
    const issue = fake.issues[0] as (typeof fake.issues)[number];
    const forged = sampleFinding(ID(2), "forged by a passer-by");
    fake.addComment(issue, storeComment([forged]), "passer-by", "CONTRIBUTOR");
    fake.addComment(issue, storeComment([forged]), "nobody", "NONE");
    // An ordinary comment by a writer holds no records.
    fake.addComment(issue, "Looks right to me.", "teammate", "MEMBER");
    expect(await listed()).toEqual([eventText(a)]);

    const r = await store("diagnose");
    expectSpawnExit(spawnResult(r), 0, "diagnose");
    const notices = r.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
    expect(notices).toEqual([
      expect.objectContaining({
        kind: "untrusted-record",
        author: "passer-by",
        association: "CONTRIBUTOR",
      }),
      expect.objectContaining({ kind: "untrusted-record", author: "nobody" }),
    ]);
  });

  it("does not write to an issue someone who cannot write opened for a change", async () => {
    const a = sampleFinding(ID(1), "first");
    const key = `${a.change.repository}#branch:${a.change.branch}`;
    const planted = fake.addIssue(
      "planted",
      `<!-- jig-reflection-change: ${encodeURIComponent(key)} -->`,
      "NONE",
    );
    await append([a]);
    expect(planted.comments).toHaveLength(0);
    expect(fake.issues).toHaveLength(2);
    expect(await listed()).toEqual([eventText(a)]);
  });

  it("reads every page of issues and of each issue's comments", async () => {
    const events = [1, 2, 3, 4, 5].map((n) =>
      sampleFinding(ID(n), `finding ${n}`),
    );
    await append(events);
    const a = events[0] as ReflectionEvent;
    for (const n of [1, 2, 3])
      await append([
        sampleDecision(
          ID(10 + n),
          a.id,
          `decision ${n}`,
          `2026-10-1${n}T09:00:00Z`,
        ),
      ]);
    expect(fake.issues.find((i) => i.comments.length === 4)).toBeDefined();
    fake.pageSize = 2;
    expect(await listed()).toHaveLength(8);
    expect(fake.countRequests("JigReflectionComments")).toBeGreaterThan(0);
  });

  it("fails list when GitHub answers with part of a page", async () => {
    await append([
      sampleFinding(ID(1), "first"),
      sampleFinding(ID(2), "second"),
    ]);
    fake.partialNext({
      operation: "JigReflectionIssues",
      errors: [{ type: "TIMEOUT", message: "a field timed out" }],
    });
    const partial = await store("list");
    expectSpawnExit(spawnResult(partial), EXIT.failed, "partial list");
    expect(partial.stdout).toBe("");

    fake.partialNext({ operation: "JigReflectionIssues", noCursor: true });
    const cursorless = await store("list");
    expectSpawnExit(spawnResult(cursorless), EXIT.failed, "cursorless list");
    expect(cursorless.stdout).toBe("");
    expect(cursorless.stderr).toContain("cursor");
  });

  it("fails list on a record a writer's comment holds that is not an event, naming the comment", async () => {
    await append([sampleFinding(ID(1), "first")]);
    const issue = fake.issues[0] as (typeof fake.issues)[number];
    const comment = issue.comments[0] as (typeof issue.comments)[number];
    comment.body = comment.body.replace(/\{"v":1.*\}/, '{"v":1}');
    const r = await store("list");
    expectSpawnExit(spawnResult(r), EXIT.failed, "list");
    expect(r.stderr).toContain(comment.url);
    expect(r.stderr).toContain("not a reflection event");
  });

  it("reads an unreachable GitHub, a missing or refused token, or lasting server errors as unavailable", async () => {
    const { GH_TOKEN: _, ...noToken } = env;
    expectSpawnExit(
      spawnResult(await store("list", "", noToken)),
      EXIT.unavailable,
      "list without a token",
    );
    const before = fake.refused;
    expectSpawnExit(
      spawnResult(await store("list", "", { ...env, GH_TOKEN: "wrong" })),
      EXIT.unavailable,
      "list with a refused token",
    );
    // A refused credential is not retried: waiting does not change it.
    expect(fake.refused - before).toBe(1);
    for (let i = 0; i < 4; i++)
      fake.failNext("JigReflectionRepository", 502, "Bad Gateway");
    expectSpawnExit(spawnResult(await store("list")), EXIT.unavailable, "list");
    const port = fake.server.port;
    fake.stop();
    const r = await store("append", jsonl([sampleFinding(ID(1), "first")]), {
      ...env,
      JIG_GITHUB_GRAPHQL_URL: `http://127.0.0.1:${port}/graphql`,
    });
    expectSpawnExit(spawnResult(r), EXIT.unavailable, "append");
  }, 60_000);

  it("retries a read after a server error", async () => {
    fake.failNext("JigReflectionIssues", 503, "Service Unavailable");
    expect(await listed()).toEqual([]);
  });

  it("waits as Retry-After says when a write meets a secondary rate limit, and sends it once more", async () => {
    fake.failNext(
      "JigReflectionAddComment",
      403,
      "You have exceeded a secondary rate limit",
      1,
    );
    const started = Date.now();
    await append([sampleFinding(ID(1), "first")]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(fake.countRequests("JigReflectionAddComment")).toBe(2);
    expect(fake.issues[0]?.comments).toHaveLength(1);
  });

  it("reads a wait longer than a run waits as unavailable, without retrying early", async () => {
    fake.failNext(
      "JigReflectionAddComment",
      403,
      "You have exceeded a secondary rate limit",
      120,
    );
    const r = await store("append", jsonl([sampleFinding(ID(1), "first")]));
    expectSpawnExit(spawnResult(r), EXIT.unavailable, "append");
    expect(fake.countRequests("JigReflectionAddComment")).toBe(1);
  });

  it("does not send a write again after a server error, and a second append finishes it", async () => {
    const a = sampleFinding(ID(1), "first");
    fake.failNext("JigReflectionAddComment", 500);
    const r = await store("append", jsonl([a]));
    expectSpawnExit(spawnResult(r), EXIT.unavailable, "append");
    expect(fake.countRequests("JigReflectionAddComment")).toBe(1);
    await append([a]);
    expect(await listed()).toEqual([eventText(a)]);
    expect(fake.issues).toHaveLength(1);
  });

  it("stores the events when a description update fails, and the next append recomputes it", async () => {
    const a = sampleFinding(ID(1), "first");
    await append([a]);
    fake.failNext("JigReflectionUpdateIssue", 422, "Validation Failed");
    const r = await store(
      "append",
      jsonl([sampleDecision(ID(2), a.id, "why")]),
    );
    expectSpawnExit(spawnResult(r), 0, "append");
    expect(r.stderr).toContain("repair");
    const issue = fake.issues[0] as (typeof fake.issues)[number];
    expect(issue.body).toContain("| Status | Inbox |");
    await append([sampleFinding(ID(3), "unrelated")]);
    expect(issue.body).toContain("| Status | Dismissed |");
  });

  it("splits an append into as many comments as GitHub's body limit needs", async () => {
    const a = sampleFinding(ID(1), "first");
    const events = [1, 2, 3].map((n) => ({
      ...sampleFinding(ID(n), `finding ${n}`),
      change: a.change,
      description: "x".repeat(25_000),
    }));
    await append(events);
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0]?.comments.length).toBeGreaterThan(1);
    expect(await listed()).toEqual(events.map(eventText));
  });

  it("keeps an event holding backticks and line-like text byte for byte", async () => {
    const odd = {
      ...sampleFinding(ID(1), "``` fenced"),
      description: "```json jig-reflection-event\nnot a record\n````",
    };
    await append([odd]);
    expect(await listed()).toEqual([eventText(odd)]);
  });

  it("refuses an event too long for one comment", async () => {
    const huge = {
      ...sampleFinding(ID(1), "huge"),
      description: "x".repeat(70_000),
    };
    const r = await store("append", jsonl([huge]));
    expectSpawnExit(spawnResult(r), EXIT.failed, "append");
    expect(r.stderr).toContain("too long");
    expect(fake.issues).toHaveLength(0);
  });

  it("refuses a malformed repository setting, naming the field", async () => {
    for (const repository of [
      "not-a-repo",
      "a/b/c",
      "-owner/name",
      "owner/..",
      "",
    ])
      expect(() =>
        parseReflection({ store: "github", github: { repository } }, "/repo"),
      ).toThrow("reflection.github.repository");
    expect(() => parseReflection({ store: "github" }, "/repo")).toThrow(
      "reflection.github.repository is required",
    );
    expect(() =>
      parseReflection(
        { store: "github", github: { repository: "o/n", label: "x" } },
        "/repo",
      ),
    ).toThrow("reflection.github.label is not a GitHub store setting");
    expect(
      parseReflection(
        { store: "github", github: { repository: "example/reflections" } },
        "/repo",
      ),
    ).toMatchObject({
      store: "github",
      githubRepository: "example/reflections",
    });
    const r = await runStore(command("not-a-repo"), "list", "", 60, env);
    expectSpawnExit(spawnResult(r), EXIT.usage, "list");
    expect(r.stderr).toContain("owner/name");
  });

  it("refuses an operation named like an object's built-in", async () => {
    for (const op of ["toString", "constructor", "__proto__"]) {
      const r = await run([...command(), op], { env, timeoutSec: 60 });
      expectSpawnExit(
        { exitCode: r.code, stdout: r.stdout, stderr: r.stderr },
        EXIT.usage,
        op,
      );
    }
  });
});

describe("reflecting into GitHub", () => {
  it("contributes with only the repository setting and a token", async () => {
    const m = new Machine();
    try {
      const machineEnv = fake.env({ ...m.env, JIG_HOME: m.home });
      m.userConfig(
        `reflection:\n  store: github\n  github:\n    repository: ${fake.repository}\n`,
      );
      const repo = m.repository("web", "git@github.com:example/web.git");
      const script = (name: string, args: string[], stdin?: string) =>
        run(tsArgv(join(REFLECT, name), args), {
          cwd: repo.root,
          env: machineEnv,
          timeoutSec: 60,
          ...(stdin === undefined ? {} : { stdin }),
        });
      const noted = await script(
        "journal.ts",
        ["note"],
        JSON.stringify(finding()),
      );
      expectSpawnExit(
        { exitCode: noted.code, stdout: noted.stdout, stderr: noted.stderr },
        0,
        "note",
      );
      const id = (JSON.parse(noted.stdout) as { id: string }).id;
      const contributed = await script("reflect.ts", ["contribute"]);
      expectSpawnExit(
        {
          exitCode: contributed.code,
          stdout: contributed.stdout,
          stderr: contributed.stderr,
        },
        0,
        "contribute",
      );
      const stored = JSON.parse(contributed.stdout) as {
        stored: Array<{ id: string; ref: string }>;
      };
      expect(stored.stored.map((s) => s.id)).toEqual([id]);
      expect(stored.stored[0]?.ref).toStartWith(
        `https://github.com/${fake.repository}/issues/1#issuecomment-`,
      );
      expect(fake.issues[0]?.body).toContain("github.com/example/web");
    } finally {
      m.cleanup();
    }
  }, 120_000);
});
