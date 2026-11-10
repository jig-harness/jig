/**
 * The configuration fit reads `do_item.post_merge_state` as do-item reads it:
 * a state short of `done` needs `pull_requests.issue_link: refs`.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The fit's findings for a repository with this configuration. */
function findings(config: string): { id: string; message: string }[] {
  const dir = scratchRepo({ ".config/jig.yaml": config });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  return (
    JSON.parse(run.out) as { findings: { id: string; message: string }[] }
  ).findings;
}

const REJECTED = "rejected:do-item (post-merge state)";

test("a post-merge state short of done with the default closes link is refused", () => {
  const found = findings("do_item:\n  post_merge_state: in_review\n");
  expect(found.find((f) => f.id === REJECTED)?.message).toContain(
    "pull_requests.issue_link: refs",
  );
});

test("a post-merge state short of done with refs is accepted", () => {
  const found = findings(
    "do_item:\n  post_merge_state: in_review\npull_requests:\n  issue_link: refs\n",
  );
  expect(found.some((f) => f.id === REJECTED)).toBe(false);
});

test("a blank post-merge closer is refused", () => {
  const found = findings('do_item:\n  post_merge_closer: "  "\n');
  expect(found.find((f) => f.id === REJECTED)?.message).toContain(
    "post_merge_closer",
  );
});
