import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  copySkillScripts,
  runScript,
  useStubForge,
  writeFixture,
} from "./scripts-harness.ts";

useStubForge();
describe.skipIf(process.platform === "win32")(
  "resolution reply precondition",
  () => {
    const confirmation =
      "<!-- coderabbit-skip-review-comment-follow-up --> Confirmed";
    const writeThread = (dir: string, replied: boolean, followUp: string) => {
      const comment = (login: string, body: string, minute: number) => ({
        author: { login },
        body,
        createdAt: `2026-01-01T00:0${minute}:00Z`,
      });
      const nodes = [comment("reviewer", "Finding", 0)];
      if (replied)
        nodes.push(comment("operator", "**accepted** — fixed guard", 1));
      nodes.push(comment("coderabbitai[bot]", followUp, 2));
      writeFileSync(
        join(dir, "reply-evidence.json"),
        JSON.stringify({
          data: {
            viewer: { login: "operator" },
            node: {
              id: "PRRT_x",
              comments: { nodes, pageInfo: { hasNextPage: false } },
            },
          },
        }),
      );
    };
    for (const postedReply of [false, true]) {
      it(`preserves transparent bot confirmations after a reply: ${postedReply}`, () => {
        const fix = writeFixture({});
        writeThread(fix.dir, postedReply, confirmation);
        const r = runScript("resolve-thread.ts", ["PRRT_x"], fix);
        expectSpawnExit({ ...r, exitCode: r.code }, postedReply ? 0 : 6);
      });
    }
    it("accepts a reply that shares the reviewer comment's timestamp, by connection order", () => {
      const fix = writeFixture({});
      const at = "2026-01-01T00:00:00Z";
      const evidence = (order: string[]) =>
        writeFileSync(
          join(fix.dir, "reply-evidence.json"),
          JSON.stringify({
            data: {
              viewer: { login: "operator" },
              node: {
                id: "PRRT_x",
                comments: {
                  nodes: order.map((login) => ({
                    author: { login },
                    body: "text",
                    createdAt: at,
                  })),
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          }),
        );
      evidence(["reviewer", "operator"]);
      let r = runScript("resolve-thread.ts", ["PRRT_x"], fix);
      expectSpawnExit({ ...r, exitCode: r.code }, 0);
      evidence(["operator", "reviewer"]);
      r = runScript("resolve-thread.ts", ["PRRT_x"], fix);
      expectSpawnExit({ ...r, exitCode: r.code }, 6);
    });
    for (const brokenSibling of [false, true]) {
      it(`keeps standalone strict and refuses a broken sibling: ${brokenSibling}`, () => {
        const fix = writeFixture({});
        const skills = join(fix.dir, "plugin", "skills");
        const scripts = copySkillScripts(skills);
        if (brokenSibling)
          mkdirSync(join(skills, "drive-pr"), { recursive: true });
        writeThread(fix.dir, true, confirmation);
        const r = runScript("resolve-thread.ts", ["PRRT_x"], fix, {
          scriptsRoot: scripts,
        });
        expectSpawnExit({ ...r, exitCode: r.code }, brokenSibling ? 1 : 6);
      });
    }
    for (const newFinding of [false, true]) {
      it(`uses the canonical chat acknowledgement rule: finding=${newFinding}`, () => {
        const fix = writeFixture({});
        writeThread(
          fix.dir,
          true,
          "<!-- coderabbit-ai-generated:v1 --> Acknowledged" +
            (newFinding ? "\n**Security** | **Major** | **Quick win**" : ""),
        );
        const r = runScript("resolve-thread.ts", ["PRRT_x"], fix, {
          env: { JIG__review__bots: '["coderabbitai[bot]"]' },
        });
        expectSpawnExit({ ...r, exitCode: r.code }, newFinding ? 6 : 0);
      });
    }
    for (const complete of [true, false]) {
      it(`reads all pages and refuses repeated cursors: ${complete}`, () => {
        const fix = writeFixture({});
        const page = (login: string, at: string, more: boolean) => ({
          data: {
            viewer: { login: "operator" },
            node: {
              id: "PRRT_x",
              comments: {
                nodes: [{ author: { login }, createdAt: at }],
                pageInfo: { hasNextPage: more, endCursor: "next" },
              },
            },
          },
        });
        writeFileSync(
          join(fix.dir, "reply-evidence.json"),
          JSON.stringify(page("reviewer", "2026-01-01T00:00:00Z", true)),
        );
        if (complete)
          writeFileSync(
            join(fix.dir, "reply-evidence-next.json"),
            JSON.stringify(page("operator", "2026-01-01T00:01:00Z", false)),
          );
        const r = runScript("resolve-thread.ts", ["PRRT_x"], fix);
        expectSpawnExit({ ...r, exitCode: r.code }, complete ? 0 : 1);
      });
    }
    for (const value of [
      null,
      { errors: [{ message: "forbidden" }] },
      {
        data: {
          viewer: { login: "operator" },
          node: {
            id: "PRRT_x",
            comments: {
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: null },
            },
          },
        },
      },
      {
        data: {
          viewer: { login: "operator" },
          node: {
            id: "PRRT_x",
            comments: {
              nodes: [{ author: null, createdAt: "bad" }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    ]) {
      it(`refuses unreadable or incomplete evidence: ${JSON.stringify(value)}`, () => {
        const fix = writeFixture({});
        writeFileSync(
          join(fix.dir, "reply-evidence.json"),
          JSON.stringify(value),
        );
        const r = runScript("resolve-thread.ts", ["PRRT_x"], fix);
        expectSpawnExit({ ...r, exitCode: r.code }, 1);
        const log = join(fix.dir, "thread-events.log");
        if (existsSync(log))
          expect(readFileSync(log, "utf8")).not.toContain("resolution");
      });
    }
    for (const reply of [null, "other", "old", "new"]) {
      it(`checks resolving login and comment order: ${reply}`, () => {
        const fix = writeFixture({});
        const nodes = [
          { author: { login: "reviewer" }, createdAt: "2026-01-01T00:01:00Z" },
        ];
        if (reply)
          nodes.push({
            author: { login: reply === "other" ? "someone-else" : "operator" },
            createdAt:
              reply === "old" ? "2026-01-01T00:00:00Z" : "2026-01-01T00:02:00Z",
          });
        writeFileSync(
          join(fix.dir, "reply-evidence.json"),
          JSON.stringify({
            data: {
              viewer: { login: "operator" },
              node: {
                id: "PRRT_x",
                comments: {
                  nodes,
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
        );
        const r = runScript("resolve-thread.ts", ["PRRT_x"], fix);
        expectSpawnExit({ ...r, exitCode: r.code }, reply === "new" ? 0 : 6);
        const log = join(fix.dir, "thread-events.log");
        if (reply !== "new" && existsSync(log))
          expect(readFileSync(log, "utf8")).not.toContain("resolution");
      });
    }
  },
);
