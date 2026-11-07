/**
 * The change probe's GitHub reads: one call holds both searches and each
 * repository's lookup; a repository the account cannot see is named, not
 * read as quiet; any other error the forge returns fails the read; a search
 * with more than one page is paged in further calls holding only the
 * searches that still have pages; nodes that are not pull requests are
 * dropped.
 */
import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import {
  changedPr,
  openPr,
  probeQuery,
  probeSearches,
  readPage,
} from "../lib/change-probe-github.ts";

const SEARCHES = ["changed", "open"] as const;

const answer = (data: Record<string, unknown>, errors?: unknown[]) =>
  JSON.stringify({ data, ...(errors === undefined ? {} : { errors }) });

const page = (
  nodes: unknown[],
  next: string | null = null,
  issueCount = nodes.length,
) => ({
  issueCount,
  pageInfo: { hasNextPage: next !== null, endCursor: next },
  nodes,
});

describe("the probe's GitHub call", () => {
  it("holds both searches over every repository, and looks each one up", () => {
    const query = probeQuery(SEARCHES, ["acme/web", "acme/api"]);
    expect(query).toContain(
      "changed: search(type: ISSUE, query: $changed, first: 100, after: $changedAfter)",
    );
    expect(query).toContain(
      "open: search(type: ISSUE, query: $open, first: 100, after: $openAfter)",
    );
    expect(query).toContain(
      'r1: repository(owner: "acme", name: "api") { nameWithOwner }',
    );
    expect(query).toContain("statusCheckRollup { state contexts");
    expect(
      probeSearches(["acme/web", "acme/api"], "2026-11-07T10:00:00Z"),
    ).toEqual({
      changed:
        "is:pr repo:acme/web repo:acme/api updated:>=2026-11-07T10:00:00Z",
      open: "is:pr is:open repo:acme/web repo:acme/api",
    });
  });

  it("names a repository the account cannot see, and fails on any other error", () => {
    const data = {
      rateLimit: { cost: 1, remaining: 4321 },
      changed: page([]),
      open: page([]),
      r0: { nameWithOwner: "acme/web" },
      r1: null,
    };
    const missing = {
      type: "NOT_FOUND",
      path: ["r1"],
      message: "Could not resolve to a Repository",
    };
    const read = readPage(answer(data, [missing]), SEARCHES, [
      "acme/web",
      "acme/private",
    ]);
    expect(
      read.ok && [read.value.unseen, read.value.cost, read.value.remaining],
    ).toEqual([["acme/private"], 1, 4321]);
    const limited = readPage(
      answer(data, [
        { type: "RATE_LIMITED", message: "API rate limit exceeded" },
      ]),
      SEARCHES,
      ["acme/web"],
    );
    expect(limited.ok).toBe(false);
    if (!limited.ok)
      expect(limited.failure.reason).toContain("API rate limit exceeded");
    expect(readPage("<html>", SEARCHES, []).ok).toBe(false);
    expect(readPage(answer({ changed: page([]) }), SEARCHES, []).ok).toBe(
      false,
    );
  });

  it("refuses a search GitHub matched more of than it returns, and one that does not say", () => {
    const read = (changed: unknown) =>
      readPage(answer({ changed, open: page([]) }), SEARCHES, []);
    // At the ceiling GitHub reports no next page, so only the count tells.
    expect(read(page([], null, 1000)).ok).toBe(true);
    const over = read(page([], null, 1001));
    expect(over.ok).toBe(false);
    expect(JSON.stringify(over)).toContain("1001");
    const { issueCount: _omitted, ...silent } = page([]);
    expect(read(silent).ok).toBe(false);
  });

  it("reads pull requests, a head without checks as NONE, and drops what is not one", () => {
    const repository = { nameWithOwner: "acme/web" };
    expect(
      changedPr({ number: 12, updatedAt: "2026-11-07T10:00:00Z", repository }),
    ).toEqual({
      slug: "acme/web",
      number: 12,
      updatedAt: "2026-11-07T10:00:00Z",
    });
    expect(changedPr({})).toBeNull();
    expect(changedPr({ number: 12, updatedAt: "soon", repository })).toBeNull();
    expect(
      openPr({
        number: 12,
        repository,
        commits: {
          nodes: [{ commit: { oid: "abc", statusCheckRollup: null } }],
        },
      }),
    ).toEqual({
      slug: "acme/web",
      number: 12,
      head: "abc",
      checks: "NONE",
      detail: "-",
    });
    expect(
      openPr({ number: 12, repository: { nameWithOwner: "not a slug" } }),
    ).toBeNull();
  });

  it("digests each check, so one that ends while the aggregate stays PENDING moves the detail", () => {
    const repository = { nameWithOwner: "acme/web" };
    const at = (nodes: unknown[], totalCount = nodes.length) =>
      openPr({
        number: 12,
        repository,
        commits: {
          nodes: [
            {
              commit: {
                oid: "abc",
                statusCheckRollup: {
                  state: "PENDING",
                  contexts: { totalCount, nodes },
                },
              },
            },
          ],
        },
      });
    const run = (name: string, status: string, conclusion: string | null) => ({
      __typename: "CheckRun",
      name,
      status,
      conclusion,
    });
    const before = at([
      run("build", "IN_PROGRESS", null),
      run("lint", "IN_PROGRESS", null),
    ]);
    const after = at([
      run("build", "COMPLETED", "SUCCESS"),
      run("lint", "IN_PROGRESS", null),
    ]);
    expect(before?.checks).toBe("PENDING");
    expect(after?.checks).toBe("PENDING");
    expect(after?.detail).not.toBe(before?.detail);
    expect(
      at([run("lint", "IN_PROGRESS", null), run("build", "IN_PROGRESS", null)])
        ?.detail,
    ).toBe(before?.detail);
    const status = {
      __typename: "StatusContext",
      context: "ci",
      state: "PENDING",
    };
    expect(at([status])?.detail).not.toBe(
      at([{ ...status, state: "SUCCESS" }])?.detail,
    );
    expect(at([run("build", "IN_PROGRESS", null)], 101)?.detail).toMatch(
      /\+100$/,
    );
  });
});

describe("the probe's GitHub search", () => {
  it("pages a search past its first hundred results in a further call holding only that search", () => {
    const root = mkdtempSync(join(tmpdir(), "change-probe-github-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      const calls = join(root, "calls.jsonl");
      writeFileSync(calls, "");
      // The open search has a second page; the updated search does not.
      writeFakeProgram(
        join(bin, "gh"),
        `#!/usr/bin/env bun
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const has = (name) => args.some((a) => a.startsWith(name + "="));
const pr = (n) => ({ number: n, updatedAt: "2026-11-07T10:00:00Z", repository: { nameWithOwner: "acme/web" }, commits: { nodes: [{ commit: { oid: "h" + n, statusCheckRollup: { state: "SUCCESS" } } }] } });
const data = { rateLimit: { cost: 1, remaining: 4990 } };
if (has("changed")) data.changed = { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [pr(1)] };
if (has("openAfter")) data.open = { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [pr(3)] };
else if (has("open")) data.open = { issueCount: 3, pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [pr(1), pr(2)] };
if (args.some((a) => a.includes("r0: repository"))) data.r0 = { nameWithOwner: "acme/web" };
process.stdout.write(JSON.stringify({ data }));
`,
      );
      const source = [
        `const { githubProbeForge } = await import(${JSON.stringify(resolve(import.meta.dir, "../lib/change-probe-github.ts"))});`,
        `console.log(JSON.stringify(await githubProbeForge.search(["acme/web"], "2026-11-07T09:50:00Z")));`,
      ].join("\n");
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        HOME: root,
      };
      const r = Bun.spawnSync([process.execPath, "-e", source], {
        env,
        timeout: 30_000,
      });
      expectSpawnExit(r, 0);
      const read = JSON.parse(r.stdout.toString());
      expect(read.ok).toBe(true);
      expect(
        read.value.changed.map((p: { number: number }) => p.number),
      ).toEqual([1]);
      expect(read.value.open.map((p: { number: number }) => p.number)).toEqual([
        1, 2, 3,
      ]);
      expect([read.value.calls, read.value.cost, read.value.unseen]).toEqual([
        2,
        2,
        [],
      ]);
      const made = readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(made).toHaveLength(2);
      expect(made[1]?.some((a) => a.startsWith("changed="))).toBe(false);
      expect(made[1]).toContain("openAfter=c1");
      expect(made[1]?.some((a) => a.includes("r0: repository"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
