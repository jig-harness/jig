/**
 * Every `gh api graphql` run of the GitHub tracker names the repository its
 * request is about in `GH_REPO`, so a `gh` that picks its account by the
 * repository's owner (a wrapper on `PATH`, the governed quota's owner) reads
 * a private repository of a second owner instead of answering `NOT_FOUND`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  facetInputs,
  parseTrackerConfig,
} from "../scripts/lib/tracker/config.ts";
import { resolveFacets } from "../scripts/lib/tracker/facets/config.ts";
import { gitHubClient } from "../scripts/lib/tracker/github/client.ts";
import { gitHubModel } from "../scripts/lib/tracker/github/model.ts";
import { gitHubTracker } from "../scripts/lib/tracker/github/tracker.ts";
import {
  ghTransport,
  requestRepository,
} from "../scripts/lib/tracker/github/transport.ts";
import type { ghCall } from "../../drive-pr/scripts/lib/proc.ts";
import { runWithFakeGh } from "../../../../lib/test-helpers/run-with-fake-gh.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { conn, issueNode } from "./github-fixtures.ts";

const PRIVATE = { owner: "other-owner", name: "private" };
const SLUG = `${PRIVATE.owner}/${PRIVATE.name}`;

const NOT_FOUND = JSON.stringify({
  data: { repository: null },
  errors: [
    {
      type: "NOT_FOUND",
      path: ["repository"],
      message: `Could not resolve to a Repository with the name '${SLUG}'.`,
    },
  ],
});

/** One run the stand-in saw: its arguments and the `GH_REPO` it was given. */
interface Seen {
  argv: string[];
  ghRepo: string | undefined;
}

/**
 * A `gh` that answers as an owner-routing wrapper does: as the default
 * account, which cannot see `PRIVATE`, unless `GH_REPO` names it.
 */
function routingGh(answer: () => unknown): {
  runner: typeof ghCall;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const runner = (async (
    argv: string[],
    opts: { env?: Record<string, string | undefined> },
  ) => {
    const ghRepo = opts.env?.GH_REPO;
    seen.push({ argv, ghRepo });
    const routed = ghRepo?.toLowerCase() === SLUG.toLowerCase();
    return {
      code: routed ? 0 : 1,
      stdout: routed ? JSON.stringify({ data: answer() }) : NOT_FOUND,
      stderr: routed ? "" : "gh: Could not resolve to a Repository",
    };
  }) as unknown as typeof ghCall;
  return { runner, seen };
}

/** A GitHub client of `PRIVATE` whose requests go through `gh` as `runner`. */
function clientThrough(runner: typeof ghCall, home: string | null) {
  const config = parseTrackerConfig({
    issue_tracker: { adapter: "github", github: { repository: SLUG } },
  });
  return gitHubClient({
    home: PRIVATE,
    model: gitHubModel(config.states, config.github),
    settings: config.github,
    transport: ghTransport(runner, home),
    facets: resolveFacets(facetInputs(config), null),
    credential: "gh's signed-in account",
  });
}

/** A GitHub tracker of `PRIVATE` whose requests go through `gh` as `runner`. */
function trackerThrough(runner: typeof ghCall, home: string | null) {
  return gitHubTracker(clientThrough(runner, home));
}

describe("the repository a GitHub tracker request is about", () => {
  it("is the one its variables name", () => {
    expect(requestRepository({ owner: "a", name: "b" }, "home/repo")).toBe(
      "a/b",
    );
  });

  it("is the one every batched pair names, ignoring case", () => {
    expect(
      requestRepository(
        { owner0: "A", name0: "B", owner1: "a", name1: "b", number0: 1 },
        "home/repo",
      ),
    ).toBe("a/b");
  });

  it("is the home repository when the variables name none or several", () => {
    expect(requestRepository({ id: "I_1" }, "home/repo")).toBe("home/repo");
    expect(requestRepository({ owner: "org", number: 7 }, "home/repo")).toBe(
      "home/repo",
    );
    expect(
      requestRepository(
        { owner0: "a", name0: "b", owner1: "c", name1: "d" },
        "home/repo",
      ),
    ).toBe("home/repo");
  });

  it("is none when neither the variables nor the transport name one", () => {
    expect(requestRepository({ id: "I_1" }, null)).toBeNull();
  });
});

describe("gh api graphql runs of the GitHub tracker", () => {
  it("carry GH_REPO naming the repository each request is about", async () => {
    const { runner, seen } = routingGh(() => ({ ok: true }));
    const transport = ghTransport(runner, SLUG);
    await transport("mutation M($id: ID!) { m(id: $id) }", { id: "I_1" });
    await transport("query Q($owner: String!, $name: String!) { ok }", {
      owner: PRIVATE.owner,
      name: PRIVATE.name,
    });
    expect(seen.map((s) => s.ghRepo)).toEqual([SLUG, SLUG]);
    for (const s of seen)
      expect(s.argv).toEqual(["api", "graphql", "--include", "--input", "-"]);
  });

  it("name another repository a request is about instead of the home one", async () => {
    const seen: (string | undefined)[] = [];
    const transport = ghTransport(
      (async (
        _argv: string[],
        opts: { env?: Record<string, string | undefined> },
      ) => {
        seen.push(opts.env?.GH_REPO);
        return { code: 0, stdout: '{"data":{}}', stderr: "" };
      }) as unknown as typeof ghCall,
      SLUG,
    );
    await transport("query Q { ok }", { owner: "acme", name: "app" });
    expect(seen).toEqual(["acme/app"]);
  });

  it("leave the inherited environment alone when nothing names a repository", async () => {
    const envs: unknown[] = [];
    const transport = ghTransport((async (
      _argv: string[],
      opts: { env?: unknown },
    ) => {
      envs.push(opts.env);
      return { code: 0, stdout: '{"data":{}}', stderr: "" };
    }) as unknown as typeof ghCall);
    await transport("query Q { viewer { login } }", {});
    expect(envs).toEqual([undefined]);
  });

  it("name the repository of the issue a mutation by node id changes", async () => {
    const { runner, seen } = routingGh(() => ({}));
    const client = clientThrough(runner, SLUG);
    const mutation = "mutation M($id: ID!) { m(id: $id) }";
    await client.mutate(mutation, { id: "I_1" });
    // The routing stand-in answers NOT_FOUND to any other repository, but the
    // run still shows which repository it was sent for.
    await client
      .mutate(mutation, { id: "I_2" }, undefined, {
        owner: "acme",
        name: "app",
      })
      .catch(() => undefined);
    expect(seen.map((s) => s.ghRepo)).toEqual([SLUG, "acme/app"]);
  });

  it("read the items assigned to an identity in a repository only the routed account sees", async () => {
    const { runner, seen } = routingGh(() => ({
      repository: {
        issues: conn([issueNode({ number: 3, assignee: "dana" })]),
      },
    }));
    const source = trackerThrough(runner, SLUG).dispatchSource;
    assert(source !== undefined);
    const read = await source.queue("dana");
    expect(read).toHaveLength(1);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.ghRepo).toBe(SLUG);
  });
});

describe("an opened GitHub tracker", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const TRACKER = join(import.meta.dir, "..", "scripts", "lib", "tracker");

  /** Open the tracker in a child whose `gh` is `gh`, and run `use` on it. */
  function runTracker(scratch: string, gh: string, use: string, args = "") {
    return runWithFakeGh({
      dir: scratch,
      gh,
      unset: ["GH_REPO", "GH_TOKEN", "GITHUB_TOKEN", "JIG_GITHUB_GRAPHQL_URL"],
      code: `import { openTracker } from ${JSON.stringify(join(TRACKER, "index.ts"))};
         import { parseTrackerConfig } from ${JSON.stringify(join(TRACKER, "config.ts"))};
         const t = openTracker(parseTrackerConfig({ issue_tracker: { adapter: "github",
           github: { repository: ${JSON.stringify(SLUG)} } } }),
           ${JSON.stringify(scratch)}${args});
         ${use}`,
    });
  }

  it("reads its assigned items through an owner-routing gh on PATH", async () => {
    dir = mkdtempSync(join(tmpdir(), "gh-routing-"));
    const result = await runTracker(
      dir,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "auth") { console.log("stand-in-token"); process.exit(0); }
await Bun.stdin.text();
if ((process.env.GH_REPO ?? "").toLowerCase() !== ${JSON.stringify(SLUG.toLowerCase())}) {
  process.stdout.write(${JSON.stringify(NOT_FOUND)});
  console.error("gh: Could not resolve to a Repository");
  process.exit(1);
}
console.log(JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }));
`,
      `const read = await t.dispatchSource.queue("dana");
         console.log(JSON.stringify({ items: read.length }));`,
    );
    expectSpawnExit(result, 0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toEqual({
      items: 0,
    });
  });

  it("names a foreign issue's repository on a write through a signal-bound tracker", async () => {
    dir = mkdtempSync(join(tmpdir(), "gh-routing-"));
    const log = join(dir, "mutations.log");
    const node = issueNode({ number: 5, repo: "acme/app" });
    const result = await runTracker(
      dir,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "auth") { console.log("stand-in-token"); process.exit(0); }
const body = await Bun.stdin.text();
if (body.includes("mutation")) {
  appendFileSync(${JSON.stringify(log)}, (process.env.GH_REPO ?? "") + "\\n");
  console.log(JSON.stringify({ data: { addComment: { commentEdge: { node: { id: "C_1" } } } } }));
} else {
  console.log(JSON.stringify({ data: { repository: { issue: ${JSON.stringify(node)} } } }));
}
`,
      `await t.postComment("acme/app#5", "hello");`,
      ", new AbortController().signal",
    );
    expectSpawnExit(result, 0);
    expect(readFileSync(log, "utf8").trim()).toBe("acme/app");
  });
});
