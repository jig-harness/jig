/**
 * drive-pr suite: a status probe whose forge reads the credential's spent
 * rate limit refuses ends `FORGE_RATE_LIMITED` with the reset in its report,
 * never `INDETERMINATE`, and does not retry reads that could only be refused
 * again.
 */
import { describe, expect, it } from "bun:test";
import {
  HEAD,
  probeIn,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { DRIVE_EXIT } from "../scripts/lib/status/terminal-states.ts";
import { currentMs, parseMs } from "../../../shared/time.ts";

useDrivePrSuite();

describe("drive-status.ts on the forge's spent rate limit", () => {
  for (const refused of ["reads", "all"] as const)
    it(`stops FORGE_RATE_LIMITED, naming the reset, when ${refused === "all" ? "the repository's read" : "the pull request's reads"} meet it`, async () => {
      const { dir, stateDir } = writeFixture({ forgeRateLimited: refused });
      const before = currentMs();
      // Not `--once`: the retry a failed read would get is what must not run.
      const r = await probeIn(dir, stateDir, HEAD, [], { once: false });
      expect(r.state).toBe("FORGE_RATE_LIMITED");
      expectSpawnExit(
        { exitCode: r.exitCode, stdout: null, stderr: r.stderr },
        DRIVE_EXIT.FORGE_RATE_LIMITED,
      );
      expect(r.stderr).not.toContain("retrying");
      const json = r.json as { rateLimit?: { until?: string } };
      expect(parseMs(json.rateLimit?.until ?? "")).toBeGreaterThan(before);
    });
});
