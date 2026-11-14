import { describe, expect, test } from "bun:test";
import { runTag } from "../scripts/tag.ts";
import { commit } from "./scratch.ts";
import {
  captured,
  changelog,
  env,
  fake,
  head,
  passed,
  plan,
  released,
} from "./tag-fixture.ts";

describe("failed release gates", () => {
  test("retries once by default, then releases the same commit after a pass", () => {
    const root = released();
    commit(root, { "CHANGELOG.md": changelog("1.3.0", "1.2.0") }, "release");
    const release = head(root);
    const checks = {
      [release]: [
        passed("test", {
          outcome: "failed",
          conclusion: "failure",
          run: { id: 99, attempt: 1, completed: true },
        }),
      ],
    };
    const asked: number[] = [];
    const hosting = fake(checks, undefined, asked);
    expect(plan(root, hosting).versions[0]?.state).toBe("rerun");
    const out = captured(() =>
      runTag(root, { json: true, rerun: true }, env(), {
        hosting,
        tags: () => new Set(["v1.2.0"]),
      }),
    );
    expect(out.code).toBe(0);
    expect(asked).toEqual([99]);
    checks[release] = [
      passed("test", { run: { id: 99, attempt: 2, completed: true } }),
    ];
    expect(plan(root, hosting).ready).toEqual([
      { tag: "v1.3.0", commit: release, message: "v1.3.0" },
    ]);
  });

  test.each([0, 1, 2])(
    "honors the configured failed-gates retry budget %i",
    (budget) => {
      const root = released(`\n  release: { rerun_failed_gates: ${budget} }`);
      commit(root, { "CHANGELOG.md": changelog("1.3.0", "1.2.0") }, "release");
      const release = head(root);
      for (const attempt of [1, 2, 3]) {
        const hosting = fake({
          [release]: [
            passed("test", {
              outcome: "failed",
              conclusion: "failure",
              run: { id: 99, attempt, completed: true },
            }),
          ],
        });
        expect(plan(root, hosting).versions[0]?.state).toBe(
          attempt <= budget ? "rerun" : "failed",
        );
      }
    },
  );

  test("does not re-run a failed check while its workflow still runs", () => {
    const root = released();
    commit(root, { "CHANGELOG.md": changelog("1.3.0", "1.2.0") }, "release");
    expect(
      plan(
        root,
        fake({
          [head(root)]: [
            passed("test", {
              outcome: "failed",
              conclusion: "failure",
              run: { id: 99, attempt: 1, completed: false },
            }),
          ],
        }),
      ).versions[0]?.state,
    ).toBe("pending");
  });
});
