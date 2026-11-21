import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExited } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { commitPolicyBase } from "../../../../lib/test-helpers/policy-base.ts";
import { PR_URL } from "./deferred-forge.ts";

const script = join(import.meta.dir, "../scripts/defer-batch.ts");
const preload = join(import.meta.dir, "fixtures/drive-deferral-cli.ts");

async function run(category: string, exit = 0) {
  const root = mkdtempSync(join(tmpdir(), "drive-deferral-"));
  try {
    const config = JSON.stringify({
      autonomy: { level: "attended" },
      issue_tracker: { adapter: "github" },
      review: {
        repo_slug: "example/project",
        taxonomy: { categories: ["correctness"] },
      },
    });
    mkdirSync(join(root, ".config"));
    mkdirSync(join(root, "home"));
    writeFileSync(join(root, ".config/jig.yaml"), config);
    const capture = join(root, "capture.md");
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        script,
        "42",
        "bug",
        "--thread-url",
        `${PR_URL}#discussion_r1`,
        "--reason",
        "Needs a separate refactor",
        "--severity",
        "high",
        "--category",
        category,
        "--originating",
        "none",
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          SYSTEMROOT: process.env.SYSTEMROOT ?? "",
          JIG_HOME: join(root, "home"),
          JIG_CONSUMER_ROOT: root,
          JIG_TEST_DEFERRAL_CAPTURE: capture,
          DRIVE_PR_TARGET: "42",
          ...commitPolicyBase(root, config),
        },
        stdin: Buffer.from("The finding itself"),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await expectSpawnExited(child, exit);
    const written = Bun.file(capture);
    const calls = Bun.file(`${capture}.calls`);
    return {
      result: exit === 0 ? await new Response(child.stdout).json() : null,
      body: (await written.exists()) ? await written.text() : null,
      calls: (await calls.exists())
        ? (await calls.text()).trim().split("\n")
        : [],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the attended drive's deferral command files directly with provenance", async () => {
  const { result, body, calls } = await run("correctness");
  expect(result).toMatchObject({ identifier: "#43", created: true });
  expect(body).toContain(
    "Filed by `/jig:drive-pr` from https://github.com/example/project/pull/42, without a person's confirmation: Needs a separate refactor",
  );
  expect(calls).toEqual([]);
});

test("the attended drive preserves a finding refused by the review taxonomy", async () => {
  const { result, body, calls } = await run("unmapped");
  expect(result).toMatchObject({
    link: `${PR_URL}#deferred`,
    why: expect.stringContaining("review.taxonomy.categories"),
  });
  expect(body).toContain("The finding itself");
  expect(body).toContain("unmapped");
  expect(calls).toEqual(["read", "read", "read", "write", "read"]);
});

test("a malformed category is refused before the fallback writes", async () => {
  const { body, calls } = await run("broken --> marker", 1);
  expect(body).toBeNull();
  expect(calls).toEqual([]);
});

test("the drive records, replies and resolves in order after filing without confirmation", async () => {
  const protocol = await Bun.file(
    join(import.meta.dir, "../references/deferral-protocol.md"),
  ).text();
  const procedure = protocol
    .split("## Who decides a deferral")[1]
    ?.split("## Batching is the default")[0];
  expect(procedure).toMatch(
    /at every autonomy level without `file-issue` confirmation[\s\S]*1\. \*\*File the issue\*\*[\s\S]*2\. \*\*Record the filing in a drive\.\*\*[\s\S]*3\. \*\*Reply on the thread\*\*[\s\S]*4\. \*\*Resolve the thread and continue to the next finding\.\*\*/,
  );
});
