/**
 * drive-pr suite: answer-summary-finding.ts, assert-post-allowed.ts, resolve-held-thread.ts, finish-round.ts and list-unresolved-threads.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { readFileSync, writeFileSync } from "node:fs";

import { join, delimiter } from "node:path";

import {
  SCRIPTS,
  binDir,
  writeFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

useDrivePrSuite();

describe("list-unresolved-threads.ts", () => {
  // The crash-recovery guard in drive-pr/SKILL.md § 3 trusts a thread comment
  // opening with a bold outcome token as proof an earlier pass already
  // triaged it — but ONLY when that comment's `authorAssociation` is
  // OWNER/MEMBER/COLLABORATOR (mirroring summary-findings.ts's
  // TRUSTED_ASSOCIATIONS gate on the same class of world-writable marker). The
  // guard itself is agent-followed prose, not code, so the only thing this
  // repo's test suite CAN pin is the mechanism the prose depends on: that the
  // field the agent must check actually reaches the NDJSON output this
  // script emits, sourced from the real GraphQL response shape.
  it("carries each comment's authorAssociation through to the NDJSON output", async () => {
    const { dir } = writeFixture({
      threads: [
        {
          id: "PRRT_spoofed",
          path: "a.ts",
          bot: false,
          authorAssociation: "NONE",
        },
        {
          id: "PRRT_trusted",
          path: "b.ts",
          bot: false,
          authorAssociation: "OWNER",
        },
      ],
    });
    const proc = Bun.spawn(
      scriptArgv(
        join(
          SCRIPTS,
          "..",
          "..",
          "resolve-review-comments",
          "scripts",
          "list-unresolved-threads.ts",
        ),
        "999",
      ),
      {
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    const lines = stdout
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            threadId: string;
            comments: Array<{ authorAssociation: string }>;
          },
      );
    const spoofed = lines.find((l) => l.threadId === "PRRT_spoofed");
    const trusted = lines.find((l) => l.threadId === "PRRT_trusted");
    expect(spoofed?.comments[0]?.authorAssociation).toBe("NONE");
    expect(trusted?.comments[0]?.authorAssociation).toBe("OWNER");
  });

  // `confirmedHumanStarted` must fail CLOSED (`false`) on a malformed or
  // absent opening-comment author shape — `ThreadCommentNode.author` and its
  // `__typename` are both optional in the real GraphQL response type, so
  // this is a modeled possibility, not a hypothetical. The `writeFixture`
  // thread DSL always constructs a definite `Bot`/`User` `__typename`
  // (via its `bot` boolean), so it cannot express this malformed shape —
  // this test writes `threads.json` directly to exercise the real GraphQL
  // response types the fixture DSL can't reach.
  it("confirmedHumanStarted fails closed on a malformed/absent opening-comment author", async () => {
    const { dir } = writeFixture({ threads: [] });
    writeFileSync(
      join(dir, "threads.json"),
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "PRRT_no_author",
                    isResolved: false,
                    isOutdated: false,
                    path: "a.ts",
                    line: 1,
                    comments: {
                      pageInfo: { hasNextPage: false },
                      // No `author` key at all on the opening comment — the
                      // exact optional-field shape `ThreadCommentNode` models.
                      nodes: [
                        { authorAssociation: "OWNER", body: "a finding" },
                      ],
                    },
                  },
                  {
                    id: "PRRT_null_author",
                    isResolved: false,
                    isOutdated: false,
                    path: "b.ts",
                    line: 1,
                    comments: {
                      pageInfo: { hasNextPage: false },
                      nodes: [
                        {
                          author: null,
                          authorAssociation: "OWNER",
                          body: "a finding",
                        },
                      ],
                    },
                  },
                  {
                    id: "PRRT_no_typename",
                    isResolved: false,
                    isOutdated: false,
                    path: "c.ts",
                    line: 1,
                    comments: {
                      pageInfo: { hasNextPage: false },
                      nodes: [
                        {
                          author: { login: "someone" },
                          authorAssociation: "OWNER",
                          body: "a finding",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const proc = Bun.spawn(
      scriptArgv(
        join(
          SCRIPTS,
          "..",
          "..",
          "resolve-review-comments",
          "scripts",
          "list-unresolved-threads.ts",
        ),
        "999",
      ),
      {
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    const lines = stdout
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as { threadId: string; confirmedHumanStarted: unknown },
      );
    for (const id of [
      "PRRT_no_author",
      "PRRT_null_author",
      "PRRT_no_typename",
    ]) {
      const line = lines.find((l) => l.threadId === id);
      expect(line?.confirmedHumanStarted).toBe(false);
    }
  });

  // The gh stub answers every `graphql` call with the same fixture file
  // regardless of the query text, so the first test alone would still pass
  // if the GraphQL query stopped requesting `authorAssociation` (the field
  // would just be `null` against the real API). Asserting against the
  // SCRIPT'S SOURCE FILE would be satisfied by an unrelated comment or string
  // containing this shape anywhere in the file, so instead run the script for
  // real and pin the query text the gh stub actually received on this
  // invocation (captured to `last-graphql-query.txt` in `beforeAll`).
  it("requests authorAssociation in the GraphQL comments selection", async () => {
    const { dir } = writeFixture({ threads: [] });
    const proc = Bun.spawn(
      scriptArgv(
        join(
          SCRIPTS,
          "..",
          "..",
          "resolve-review-comments",
          "scripts",
          "list-unresolved-threads.ts",
        ),
        "999",
      ),
      {
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const submittedQuery = readFileSync(
      join(dir, "last-graphql-query.txt"),
      "utf8",
    );
    expect(submittedQuery).toMatch(
      /nodes\{\s*url\s+author\{[^}]*\}\s*authorAssociation\s+body\s*\}/,
    );
  });
});
