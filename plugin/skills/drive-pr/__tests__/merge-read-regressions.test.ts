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
    Date.now = () => Number(readFileSync(clock, "utf8"));
    const read = await readMergeFacts("example-org/repo", Array.from({ length: 41 }, (_, i) => i + 1), 30);
    console.log(JSON.stringify(read));
  `,
    `#!/usr/bin/env bun
    import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
    const root = process.env.MERGE_FIXTURE;
    appendFileSync(root + "/calls", "query\\n");
    writeFileSync(root + "/clock", String(Number(readFileSync(root + "/clock", "utf8")) + 20000));
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
        commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: { ...none, nodes: [{ __typename: "CheckRun", name: "AI review", status: "COMPLETED", conclusion: "SUCCESS", checkSuite: { app: { slug: "example-review" } } }] } } } }] }
      } } } }));
      `,
    );
    expectSpawnExit(r, 0);
    expect(r.stdout.trim()).toBe("4");
    expect(r.calls).toContain("DELETE");
  }
});
