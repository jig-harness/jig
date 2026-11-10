/**
 * drive-pr: the state label follows only a ledger the drive itself wrote. A
 * `handoff` whose guards refused the write (a lost acquisition, a newer
 * takeover claim, a ledger that is not the stopped driver's) tells the drive
 * so, when it asks, and the drive writes no label for it: neither at the arm
 * nor at the stop.
 */
import { describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  type Ledger,
  ledgerFromState,
  renderClaim,
} from "../scripts/lib/state/ledger.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import {
  driverEnv,
  fakeForge,
  forgeComment,
  ledgerBody,
  runScript,
} from "./ledger-forge-fixtures.ts";
import { afterHandoff } from "../scripts/lib/driver/ledger.ts";
import {
  HANDOFF_TELLS_REFUSED,
  LEDGER_NOT_WRITTEN_EXIT,
  LEDGER_REFUSED_EXIT,
  handoffExit,
} from "../scripts/lib/state/ledger-mirror.ts";

function ledger(generation: number): Ledger {
  return ledgerFromState(
    { ...freshState(999), rounds: 2, phase: "pass" },
    {
      generation,
      driver: {
        actor: "wt-aaaaaaaaaaaaaaaa",
        clone: "clone-a",
        heartbeat: "2026-10-01T11:00:00.000Z",
        state: "running",
      },
      narrative: [],
      claims: [],
    },
  );
}

describe("handoff's exit", () => {
  it("is LEDGER_REFUSED_EXIT for a write a newer takeover claim refuses, when the caller asks", async () => {
    const claim = renderClaim({
      actor: "wt-cccccccccccccccc",
      clone: "clone-c",
      generation: 3,
      at: "2026-10-01T12:00:00.000Z",
    });
    const forge = () =>
      fakeForge(
        [
          forgeComment(40, ledgerBody(ledger(3))),
          forgeComment(80, claim, "other-bot"),
        ],
        { login: "drive-bot" },
      );
    const run = (
      f: ReturnType<typeof fakeForge>,
      env: Record<string, string>,
    ) =>
      runScript(f, "drive-state.ts", ["handoff", "999"], {
        DRIVE_PR_LEDGER_DRIVER: driverEnv("clone-b"),
        ...env,
      });
    const told = await run(forge(), { [HANDOFF_TELLS_REFUSED]: "1" });
    expectSpawnExit(told, LEDGER_REFUSED_EXIT);
    expect(told.stderr).toContain("newer takeover claim (comment 80)");
    expectSpawnExit(await run(forge(), {}), 0);
  });

  it("is 0 for a write that landed, asked or not", async () => {
    const r = await runScript(
      fakeForge([], { login: "drive-bot" }),
      "drive-state.ts",
      ["handoff", "999"],
      {
        DRIVE_PR_LEDGER_DRIVER: driverEnv("clone-b"),
        [HANDOFF_TELLS_REFUSED]: "1",
      },
    );
    expectSpawnExit(r, 0);
  });

  it("tells a refused write apart only to a caller that asks", () => {
    const asks = { [HANDOFF_TELLS_REFUSED]: "1" };
    expect(handoffExit("refused", asks)).toBe(LEDGER_REFUSED_EXIT);
    expect(handoffExit("refused", {})).toBe(0);
    expect(handoffExit("written", asks)).toBe(0);
    expect(handoffExit("failed", asks)).toBe(LEDGER_NOT_WRITTEN_EXIT);
  });
});

describe("what follows the drive's ledger write", () => {
  it("labels a write that landed, and none the guards refused or that did not land", () => {
    expect(afterHandoff(0)).toBe("label");
    expect(afterHandoff(LEDGER_REFUSED_EXIT)).toBe("refused");
    expect(afterHandoff(LEDGER_NOT_WRITTEN_EXIT)).toBe("unwritten");
  });
});
