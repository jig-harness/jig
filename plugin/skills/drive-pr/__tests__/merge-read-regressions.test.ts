/** Live announcement wording and the shared deadline across board query pages. */
import { expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const LIB = resolve(import.meta.dir, "../scripts/lib");

async function run(code: string, fake: string) {
  const root = mkdtempSync(join(tmpdir(), "jig-merge-read-"));
  try {
    writeFakeProgram(join(root, "gh"), fake);
    writeFileSync(join(root, "calls"), "");
    const script = join(root, "run.ts");
    writeFileSync(script, code);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("DRIVE_PR_")),
    );
    const child = Bun.spawn([process.execPath, script], {
      env: {
        ...env,
        PATH: `${root}${delimiter}${process.env.PATH}`,
        MERGE_FIXTURE: root,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      stdout,
      stderr,
      exitCode,
      calls: readFileSync(join(root, "calls"), "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("updates an existing announcement when the same head changes lanes", async () => {
  const r = await run(
    `
    import { reconcileWording, APPROVAL_WARNING } from ${JSON.stringify(join(LIB, "announce-wording.ts"))};
    import { writeFileSync, readFileSync } from "node:fs";
    const file = process.env.MERGE_FIXTURE + "/body";
    const initial = "**Safe to merge from the driver's perspective.**\\n\\nReady\\n\\n<!-- drive-pr-merge-ready: ${"a".repeat(40)} -->";
    writeFileSync(file, initial);
    const first = await reconcileWording("7", [1], "${"a".repeat(40)}", "approve-first", false);
    const warned = readFileSync(file, "utf8").includes(APPROVAL_WARNING);
    const second = await reconcileWording("7", [1], "${"a".repeat(40)}", "merge-now", false);
    console.log(JSON.stringify({ first, second, warned, restored: readFileSync(file, "utf8").replace(/\\n{3,}/g, "\\n\\n") === initial }));
  `,
    `#!/usr/bin/env bun
    import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
    const root = process.env.MERGE_FIXTURE;
    const args = process.argv.slice(2);
    appendFileSync(root + "/calls", JSON.stringify(args) + "\\n");
    const file = root + "/body";
    if (args.includes("PATCH")) { const value = await Bun.stdin.json(); writeFileSync(file, value.body); console.log("{}"); }
    else if (args.some((a) => a.includes("/issues/comments/"))) console.log(JSON.stringify({ body: readFileSync(file, "utf8") }));
    else console.log(JSON.stringify([[{ id: 1, body: readFileSync(file, "utf8"), user: { login: "maintainer" }, author_association: "OWNER" }]]));
  `,
  );
  expectSpawnExit(r, 0);
  expect(JSON.parse(r.stdout)).toEqual({
    first: 0,
    second: 0,
    warned: true,
    restored: true,
  });
  expect(r.calls.match(/PATCH/g)).toHaveLength(2);
});

it("stops paging once the shared merge-facts deadline is spent", async () => {
  const r = await run(
    `
    import { readMergeFacts } from ${JSON.stringify(join(LIB, "merge-facts.ts"))};
    import { readFileSync, writeFileSync } from "node:fs";
    const clock = process.env.MERGE_FIXTURE + "/clock";
    writeFileSync(clock, "0");
    Temporal.Now.instant = () =>
      Temporal.Instant.fromEpochMilliseconds(Number(readFileSync(clock, "utf8")));
    const read = await readMergeFacts("example-org/repo", Array.from({ length: 41 }, (_, i) => i + 1), 30);
    console.log(JSON.stringify(read));
  `,
    `#!/usr/bin/env bun
    import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
    const root = process.env.MERGE_FIXTURE;
    appendFileSync(root + "/calls", "query\\n");
    writeFileSync(root + "/clock", String(Number(readFileSync(root + "/clock", "utf8")) + 15000));
    console.log(JSON.stringify({ data: { repository: {} } }));
  `,
  );
  expectSpawnExit(r, 0);
  expect(JSON.parse(r.stdout)).toMatchObject({
    ok: false,
    failure: { reason: expect.stringContaining("deadline") },
  });
  expect(r.calls.trim().split("\n")).toHaveLength(2);
});

it("names the repository it reads in GH_REPO, for a gh that routes by owner", async () => {
  const r = await run(
    `
    import { readMergeFacts } from ${JSON.stringify(join(LIB, "merge-facts.ts"))};
    console.log(JSON.stringify(await readMergeFacts("other-owner/private", [1], 30)));
  `,
    `#!/usr/bin/env bun
    import { appendFileSync } from "node:fs";
    appendFileSync(process.env.MERGE_FIXTURE + "/calls", (process.env.GH_REPO ?? "") + "\\n");
    if (process.env.GH_REPO !== "other-owner/private") {
      console.error("gh: Could not resolve to a Repository with the name 'other-owner/private'.");
      process.exit(1);
    }
    console.log(JSON.stringify({ data: { repository: {} } }));
  `,
  );
  expectSpawnExit(r, 0);
  expect(JSON.parse(r.stdout)).toMatchObject({ ok: true });
  expect(r.calls.trim().split("\n")).toEqual(["other-owner/private"]);
});

it("withdraws standing wording when the final readiness read changes", async () => {
  for (const changed of ["approval", "thread", "hold"]) {
    const r = await run(
      `
      process.env.JIG__review__reviewer_app = "example-review";
      process.env.JIG__dispatch__labels__enabled = "true";
      import { laneHolds } from ${JSON.stringify(join(LIB, "announce-ready.ts"))};
      console.log(await laneHolds("7", "${"a".repeat(40)}", "merge-now", [1]));
      `,
      `#!/usr/bin/env bun
      import { appendFileSync } from "node:fs";
      const args = process.argv.slice(2);
      appendFileSync(process.env.MERGE_FIXTURE + "/calls", JSON.stringify(args) + "\\n");
      if (args.includes("DELETE")) { console.log("{}"); process.exit(0); }
      const none = { nodes: [], pageInfo: { hasNextPage: false } };
      const head = "${"a".repeat(40)}";
      console.log(JSON.stringify({ data: { repository: { squashMergeAllowed: true, pr7: {
        number: 7, headRefOid: head, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: ${JSON.stringify(changed === "approval" ? "BLOCKED" : "CLEAN")},
        reviewDecision: ${JSON.stringify(changed === "approval" ? "REVIEW_REQUIRED" : "APPROVED")}, authorAssociation: "MEMBER", isMergeQueueEnabled: false,
        labels: { ...none, nodes: ${JSON.stringify(changed === "hold" ? [{ name: "jig:hold" }] : [])} },
        reviewThreads: { ...none, nodes: ${JSON.stringify(changed === "thread" ? [{ isResolved: false }] : [])} },
        reviewRequests: none,
        latestReviews: { ...none, nodes: [{ state: "APPROVED", authorAssociation: "MEMBER", author: { __typename: "User", login: "maintainer" }, commit: { oid: head } }] },
        commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: { ...none, nodes: [{ __typename: "CheckRun", name: "AI review", status: "COMPLETED", conclusion: "SUCCESS", isRequired: false, checkSuite: { app: { slug: "example-review" } } }] } } } }] }
      } } } }));
      `,
    );
    expectSpawnExit(r, 0);
    expect(r.stdout.trim()).toBe("4");
    expect(r.calls).toContain("DELETE");
  }
});

for (const scenario of [
  "passing",
  "failing",
  "superseded",
  "capped",
  "wrong-head",
  "unreadable-entry",
  "unreadable-first-page",
  "deadline",
] as const) {
  it(`places a converged pull request using paginated checks (${scenario})`, async () => {
    const r = await run(
      `
      import { readMergeFacts } from ${JSON.stringify(join(LIB, "merge-facts.ts"))};
      import { readiness } from ${JSON.stringify(join(LIB, "merge-ready.ts"))};
      import { readFileSync, writeFileSync } from "node:fs";
      if (${JSON.stringify(scenario)} === "deadline") {
        const clock = process.env.MERGE_FIXTURE + "/clock";
        writeFileSync(clock, "0");
        Temporal.Now.instant = () =>
          Temporal.Instant.fromEpochMilliseconds(Number(readFileSync(clock, "utf8")));
      }
      const repo = "example-org/repo";
      const read = await readMergeFacts(repo, [7], 30);
      if (!read.ok) throw new Error(read.failure.reason);
      const facts = read.value.pulls.get(7);
      const placed = readiness({
        ...facts, slug: repo, converged: true, verifiedSha: facts.head, held: false,
      }, {
        reviewerApp: "example-review", reviewerCheck: /^AI review$/, ciHoldLabel: null,
      });
      console.log(JSON.stringify({ placed, partial: facts.partial, count: facts.checks.length, cost: read.value.cost }));
      `,
      `#!/usr/bin/env bun
      import { appendFileSync, writeFileSync } from "node:fs";
      const head = "${"a".repeat(40)}";
      const args = process.argv.slice(2);
      const scenario = ${JSON.stringify(scenario)};
      const after = Number(args.find((arg) => arg.startsWith("after="))?.slice("after=".length) ?? 0);
      appendFileSync(process.env.MERGE_FIXTURE + "/calls", JSON.stringify(args) + "\\n");
      if (scenario === "deadline") writeFileSync(process.env.MERGE_FIXTURE + "/clock", after ? "30800" : "29500");
      const check = (id, name, conclusion = "SUCCESS", app = "github-actions", startedAt = "2026-11-08T10:00:00Z") => ({
        __typename: "CheckRun", databaseId: id, name, status: "COMPLETED",
        conclusion, startedAt, isRequired: app !== "example-review", checkSuite: { app: { slug: app } },
      });
      const checks = Array.from({ length: after ? 40 : 100 },
        (_, i) => check(after * 100 + i + 1, "check-" + (after * 100 + i + 1)));
      if (!after) {
        checks[0] = check(1, "AI review", "SUCCESS", "example-review");
        if (scenario === "superseded") checks[1] = check(2, "retried-check");
      }
      if (after && scenario === "failing") checks[39] = check(140, "last-required", "FAILURE");
      if (after && scenario === "superseded")
        checks[39] = check(140, "retried-check", "FAILURE", "github-actions", "2026-11-08T09:00:00Z");
      if (after && scenario === "unreadable-entry") checks[39] = null;
      if (!after && scenario === "unreadable-first-page") delete checks[99].isRequired;
      const contexts = {
        nodes: checks, pageInfo: { hasNextPage: !after || scenario === "capped", endCursor: String(after + 1) },
      };
      const commit = { oid: after && scenario === "wrong-head" ? "b".repeat(40) : head, statusCheckRollup: { contexts } };
      const none = { nodes: [], pageInfo: { hasNextPage: false } };
      const repository = after ? { head: commit } : {
        squashMergeAllowed: true,
        pr7: {
          number: 7, headRefOid: head, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
          authorAssociation: "MEMBER", labels: none, reviewThreads: none, reviewRequests: none,
          latestReviews: none, commits: { nodes: [{ commit }] },
        },
      };
      console.log(JSON.stringify({ data: { repository, rateLimit: { cost: 1, remaining: 100 - after, limit: 100 } } }));
      `,
    );
    expectSpawnExit(r, 0);
    const result = JSON.parse(r.stdout);
    const calls = r.calls.trim().split("\n");
    expect(result.cost).toBe(
      scenario === "deadline" ? calls.length - 1 : calls.length,
    );
    const partialRequests = {
      capped: 4,
      "wrong-head": 2,
      "unreadable-entry": 2,
      "unreadable-first-page": 1,
      deadline: 2,
    } as const;
    if (scenario in partialRequests) {
      expect(calls).toHaveLength(
        partialRequests[scenario as keyof typeof partialRequests],
      );
      expect(result.placed).toMatchObject({ place: "stay", lane: null });
      expect(result.partial).toContain("checks");
      if (scenario === "capped") expect(result.partial).toContain("4-page cap");
    } else {
      expect(calls).toHaveLength(2);
      expect(result).toMatchObject({ count: 140, partial: null });
      expect(calls[1]).toContain(`head=${"a".repeat(40)}`);
      if (scenario === "failing") {
        expect(result.placed).toMatchObject({
          lane: null,
          failing: ["last-required"],
        });
        expect(result.placed.says).toContain("last-required");
      } else {
        expect(result.placed).toMatchObject({
          place: "ready",
          lane: "merge-now",
        });
      }
    }
  });
}
