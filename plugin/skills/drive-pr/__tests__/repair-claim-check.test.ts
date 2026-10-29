/**
 * A repair pass is spawned behind the same `beforePass` checkpoint as a
 * review pass, so a takeover claim read there (exit `20`) ends the drive
 * before the repair pass starts beside the successor.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRepairPass } from "../scripts/lib/driver/repair.ts";
import { TAKEN_OVER_EXIT } from "../scripts/lib/driver/settings.ts";

describe("the repair pass's pre-spawn checkpoint", () => {
  it("asks for the claim check and spawns nothing once it reports a takeover", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "repair-claim-")), "ran");
    const asked: Array<{ beforePass?: boolean } | undefined> = [];
    const dispatch = await runRepairPass(
      [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`,
      ],
      [],
      "ci-repair",
      "gates",
      async (opts) => {
        asked.push(opts);
        return opts?.beforePass === true ? TAKEN_OVER_EXIT : "clear";
      },
    );
    expect(asked).toEqual([{ beforePass: true }]);
    expect(dispatch).toEqual({
      dispatched: false,
      resumed: false,
      code: TAKEN_OVER_EXIT,
    });
    expect(existsSync(marker)).toBe(false);
  });
});
