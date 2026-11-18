/**
 * `jig ask`'s *Last run* line, through the `jig` command over the
 * dispatcher's outcome log in the child's own home: the last run's stage,
 * when it ended, what its closing report concluded and the next step it
 * suggests, printed as `last.run` and carried in `--json` as `last.stage`
 * and `last.report`; a run that ended with `by: none` reads as ended
 * without a report, naming its transcript's copy while there is one.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { type EndedRow, writeRow } from "../../dispatch/lib/log.ts";
import { ledgerBody } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { stoppedLedger } from "../../dispatch/__tests__/fixtures.ts";
import type { AskAnswer } from "../lib/answer.ts";
import {
  type AskWorld,
  askWorld,
  comment,
  pullDoc,
  REPO,
} from "./ask-fixtures.ts";

let current: AskWorld | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** A world whose pull request 9 has a stopped drive and `extra` as its last ended run. */
function world(extra: Partial<EndedRow>): AskWorld {
  const w = askWorld();
  current = w;
  w.api("user", { login: "drive-bot" });
  w.api(`repos/${REPO}/pulls/9`, pullDoc(9));
  w.api(`repos/${REPO}/issues/9/comments`, [
    comment(901, ledgerBody(stoppedLedger(9, 16))),
  ]);
  writeRow(
    {
      kind: "ended",
      key: "ended 20261104T100000Z-22222222",
      at: "2026-11-04T11:00:00.000Z",
      repo: REPO,
      stage: "takeover",
      target: "PR #9",
      record: "20261104T100000Z-22222222",
      account: "account-a",
      model: null,
      durationMs: 600_000,
      rounds: 1,
      class: "quota wall",
      reason: "exit 16 (quota-parked)",
      next: { none: "no handoff was recorded: exit 16 (quota-parked)" },
      ...extra,
    },
    w.state,
  );
  return w;
}

async function ask(w: AskWorld): Promise<{ text: string; answer: AskAnswer }> {
  const text = await w.ask([`drive@${REPO}#9`]);
  expectSpawnExit(text, 0);
  const json = await w.ask([`drive@${REPO}#9`, "--json"]);
  expectSpawnExit(json, 0);
  return { text: text.stdout, answer: JSON.parse(json.stdout) as AskAnswer };
}

describe("jig ask's last run", () => {
  it("names the stage, when it ended, what it concluded and the next step it suggests", async () => {
    const { text, answer } = await ask(
      world({
        by: "driver",
        concluded: "Stopped at round 1 on the account's usage limit.",
        suggested_next: {
          step: "Re-arm the drive once the limit resets.",
          owner: "line",
        },
        cause: "usage-limit",
      }),
    );
    expect(text).toContain(
      "last.run takeover, ended 2026-11-04T11:00:00.000Z: Stopped at round 1 on the account's usage limit. · suggested next: Re-arm the drive once the limit resets. (line)",
    );
    expect(answer.last).toMatchObject({
      stage: "takeover",
      report: {
        by: "driver",
        concluded: "Stopped at round 1 on the account's usage limit.",
        suggested_next: {
          step: "Re-arm the drive once the limit resets.",
          owner: "line",
        },
        cause: "usage-limit",
      },
    });
  });

  it("says a person's act beside a step a person takes", async () => {
    const { text } = await ask(
      world({
        by: "agent",
        concluded: "Parked on the schema question.",
        suggested_next: {
          step: "Choose the schema.",
          owner: "person",
          act: "Decide",
        },
      }),
    );
    expect(text).toContain(
      "suggested next: Choose the schema. (person, Decide)",
    );
  });

  it("reads a run that left no report as ended without one", async () => {
    const { text, answer } = await ask(world({ by: "none" }));
    expect(text).toContain(
      "last.run takeover, ended 2026-11-04T11:00:00.000Z: ended without a report",
    );
    expect(answer.last?.report).toEqual({ by: "none" });
  });

  it("names the transcript's copy on the host for a run that left no report", async () => {
    const path = "/state/runs/20261104T100000Z-22222222/transcript.jsonl";
    const { text, answer } = await ask(world({ by: "none", transcript: path }));
    expect(text).toContain(
      `ended without a report; its transcript's copy is ${path}`,
    );
    expect(answer.last?.report).toEqual({ by: "none", transcript: path });
  });

  it("says no report was kept for a row written before reports were", async () => {
    const { text, answer } = await ask(world({}));
    expect(text).toContain(
      "last.run takeover, ended 2026-11-04T11:00:00.000Z: no closing report was kept",
    );
    expect(answer.last).not.toHaveProperty("report");
  });
});
