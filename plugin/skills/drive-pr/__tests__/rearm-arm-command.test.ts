/**
 * drive-pr suite: the arm command a stop prints for a person to copy. It
 * carries the drive's own pass command, so a drive whose passes run another
 * agent tool is re-armed with that tool, and falls back to the documented
 * Claude Code pass only when no pass command is known.
 */

import { describe, expect, it } from "bun:test";
import { armCommand } from "../scripts/lib/driver/rearm.ts";

describe("armCommand", () => {
  it("prints the drive's own pass command, quoted word by word", () => {
    const agent = [
      "codex",
      "exec",
      "--full-auto",
      "/jig:drive-pr --bots-only 7",
    ];
    expect(armCommand("/s/drive.ts", "7", true, "", agent)).toBe(
      "bun /s/drive.ts 7 --bots-only -- codex exec --full-auto '/jig:drive-pr --bots-only 7'",
    );
  });

  it("keeps the flags before the separator", () => {
    expect(
      armCommand("/s/drive.ts", "7", false, " --take-over", [
        "claude",
        "-p",
        "/jig:drive-pr 7",
      ]),
    ).toBe("bun /s/drive.ts 7 --take-over -- claude -p '/jig:drive-pr 7'");
  });

  it("falls back to the Claude Code pass when no pass command is known", () => {
    expect(armCommand("/s/drive.ts", "7", true)).toBe(
      'bun /s/drive.ts 7 --bots-only -- claude -p "/jig:drive-pr --bots-only 7"',
    );
  });
});
