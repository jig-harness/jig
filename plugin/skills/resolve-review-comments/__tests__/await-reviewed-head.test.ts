import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  HEAD_A,
  binDir,
  HEAD_B,
  runScript,
  useStubForge,
  writeFixture,
} from "./scripts-harness.ts";

import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { shellQuote } from "../../../shared/cli.ts";

useStubForge();

describe.skipIf(process.platform === "win32")(
  "await-round reviewed head",
  () => {
    for (const marker of [HEAD_B, "", HEAD_A]) {
      it(`requires current reviewer evidence (marker ${marker || "absent"})`, () => {
        const fix = writeFixture({ head: HEAD_A });
        writeFileSync(
          join(fix.dir, "scanner-runs.json"),
          JSON.stringify([
            {
              check_runs: [
                {
                  id: 1,
                  name: "AI review",
                  status: "completed",
                  conclusion: "success",
                  app: { slug: "review-bot" },
                },
              ],
            },
          ]),
        );
        writeFileSync(
          join(fix.dir, "issue-comments.json"),
          JSON.stringify([
            [
              {
                id: 1,
                user: { login: "review-bot[bot]" },
                body: `<!-- ai-code-review -->\n${marker ? `<!-- ai-reviewed-sha: ${marker} -->` : ""}`,
              },
            ],
          ]),
        );
        const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
          env: { DRIVE_PR_REVIEWER_APP: "review-bot" },
        });
        expectSpawnExit({ ...r, exitCode: r.code }, marker === HEAD_A ? 3 : 4);
        if (marker !== HEAD_A) expect(r.stderr).not.toContain("converged:");
      });
    }
  },
);

describe.skipIf(process.platform === "win32")(
  "await-round head movement",
  () => {
    it("refuses convergence after a push during the reviewer evidence read", () => {
      const fix = writeFixture({ head: HEAD_A });
      writeFileSync(
        join(fix.dir, "scanner-runs.json"),
        JSON.stringify([
          {
            check_runs: [
              {
                id: 1,
                name: "AI review",
                status: "completed",
                conclusion: "success",
                app: { slug: "review-bot" },
              },
            ],
          },
        ]),
      );
      writeFileSync(
        join(fix.dir, "issue-comments.json"),
        JSON.stringify([
          [
            {
              id: 1,
              user: { login: "review-bot[bot]" },
              body: `<!-- ai-code-review -->\n<!-- ai-reviewed-sha: ${HEAD_A} -->`,
            },
          ],
        ]),
      );
      const wrapper = join(fix.dir, "push-during-read");
      mkdirSync(wrapper);
      writeFakeProgram(
        join(wrapper, "gh"),
        [
          "#!/bin/sh",
          `case "$*" in *issues/*/comments*) printf '%s\\n' ${shellQuote(HEAD_B)} > ${shellQuote(join(fix.dir, "head"))} ;; esac`,
          `exec ${shellQuote(join(binDir, "gh"))} "$@"`,
        ].join("\n"),
      );
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
        env: {
          DRIVE_PR_REVIEWER_APP: "review-bot",
          PATH: `${wrapper}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
        },
      });
      expectSpawnExit({ ...r, exitCode: r.code }, 4);
      expect(r.stderr).toContain("head changed while checking review evidence");
      expect(r.stderr).not.toContain("converged:");
    });
  },
);
