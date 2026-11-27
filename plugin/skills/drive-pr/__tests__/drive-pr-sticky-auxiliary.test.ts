import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SCRIPTS, useDrivePrSuite } from "./drive-pr-harness.ts";

useDrivePrSuite();

async function pick(comments: string): Promise<string> {
  const src = join(SCRIPTS, "lib", "status", "summary-sticky.ts");
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `const m = await import(${JSON.stringify(src)});
       const u = { login: 'reviewer[bot]' };
       const picked = m.selectReviewerSticky([${comments}], (body) => body.includes('- finding'));
       console.log(JSON.stringify(picked?.id));`,
    ],
    {
      env: {
        ...process.env,
        DRIVE_PR_STICKY_MARKER: "<!-- other-review -->",
        DRIVE_PR_SHA_MARKER: "custom+sha",
        DRIVE_PR_REVIEWER_APP: "reviewer",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  return out.trim();
}

describe("selectReviewerSticky auxiliary comments", () => {
  it("keeps an unstamped higher-round comment from hiding a later finding-bearing summary", async () => {
    // Overrides are read lazily, so the import runs in a subprocess.
    const src = join(SCRIPTS, "lib", "status", "summary-sticky.ts");
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `const m = await import(${JSON.stringify(src)});
         const u = { login: 'reviewer[bot]' };
         const picked = m.selectReviewerSticky([
           { id: 1, user: u, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 2 -->' },
           { id: 2, user: u, body: '<!-- other-review -->\\n<!-- ai-review-round: 3 -->' },
           { id: 3, user: u, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 2 -->\\n- finding' },
         ], (body) => body.includes('- finding'));
         console.log(JSON.stringify(picked?.id));`,
      ],
      {
        env: {
          ...process.env,
          DRIVE_PR_STICKY_MARKER: "<!-- other-review -->",
          DRIVE_PR_SHA_MARKER: "custom+sha",
          DRIVE_PR_REVIEWER_APP: "reviewer",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("3");
  });

  it("keeps an initial unstamped comment from hiding a later stamped finding-bearing summary", async () => {
    const out = await pick(`
      { id: 2, user: u, body: '<!-- other-review -->\\n<!-- ai-review-round: 3 -->' },
      { id: 3, user: u, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 2 -->\\n- finding' },
    `);
    expect(out).toBe("3");
  });
});
