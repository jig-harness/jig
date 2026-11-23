/**
 * The diagnosing repair pass's receipt, judged without a drive: what
 * `readDiagnosis` accepts from the report file, and what `judgeReceipt` makes
 * of a tracker issue key or a parked filing against the drive state. The
 * end-to-end wiring (repair, diagnose, spent budget) is pinned in
 * drive-pr-drive-final-ci.test.ts.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DiagnosisReport,
  judgeReceipt,
  readDiagnosis,
} from "../scripts/lib/driver/ci-diagnosis.ts";
import { diagnosisStartedPrefix } from "../scripts/lib/state/ci-actions.ts";
import { HUMAN_DECISION_CLASS } from "../scripts/lib/state/rulings.ts";
import { type DriveState, freshState } from "../scripts/lib/state/schema.ts";

const dir = mkdtempSync(join(tmpdir(), "ci-diagnosis-receipt-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let reports = 0;
/** `body` written as a report file; its path. */
function report(body: string): string {
  const path = join(dir, `report-${++reports}.json`);
  writeFileSync(path, body);
  return path;
}
const read = (value: unknown) => readDiagnosis(report(JSON.stringify(value)));

const HEAD = "a".repeat(40);
const FILING = "ci-diagnosis-filing";
const STARTED_AT = "2026-11-20T10:00:00.000Z";
const INCOMPLETE =
  "a diagnosis and either a tracker issue key or the key of the filing it parked";

/** A drive state whose diagnosis of HEAD started at STARTED_AT, holding `parked`. */
function stateWith(parked: DriveState["parked"]): DriveState {
  return {
    ...freshState(999),
    ciActions: [
      {
        at: STARTED_AT,
        round: 1,
        action: "repair",
        detail: `${diagnosisStartedPrefix(HEAD)}code-quality-and-build`,
      },
    ],
    parked,
  };
}
const park = (overrides: Partial<DriveState["parked"][number]> = {}) => ({
  key: FILING,
  kind: "finding" as const,
  reason: "File the recurring CI cause as a tracker issue",
  round: 1,
  at: "2026-11-20T10:05:00.000Z",
  class: HUMAN_DECISION_CLASS,
  ...overrides,
});
const judge = (answer: DiagnosisReport | null, state: DriveState | null) =>
  judgeReceipt("999", HEAD, answer, async () => state);

describe("readDiagnosis", () => {
  it("reads a diagnosis with a tracker issue key", () => {
    expect(
      read({ diagnosis: "the local gate ran no tests", issue: "#42" }),
    ).toEqual({
      diagnosis: "the local gate ran no tests",
      issue: "#42",
      parked: undefined,
      pushedHead: undefined,
    });
  });

  it("reads a diagnosis naming the filing it parked", () => {
    expect(read({ diagnosis: "done", parked: FILING })).toEqual({
      diagnosis: "done",
      issue: undefined,
      parked: FILING,
      pushedHead: undefined,
    });
  });

  it("refuses a malformed tracker issue key", () => {
    expect(
      read({ diagnosis: "the local gate ran no tests", issue: "not a key" }),
    ).toBeNull();
  });

  it("refuses a report with no issue key and no parked filing", () => {
    expect(read({ diagnosis: "done" })).toBeNull();
  });

  it("refuses a report naming both an issue key and a parked filing", () => {
    expect(
      read({ diagnosis: "done", issue: "#42", parked: FILING }),
    ).toBeNull();
  });

  it("refuses a park key spanning lines", () => {
    expect(read({ diagnosis: "done", parked: "a\nb" })).toBeNull();
  });

  it("refuses an empty diagnosis and a pushed head that is no commit", () => {
    expect(read({ diagnosis: "  ", issue: "#42" })).toBeNull();
    expect(
      read({ diagnosis: "done", issue: "#42", pushedHead: "main" }),
    ).toBeNull();
  });

  it("reads the stand-down and stale-head markers", () => {
    expect(read({ standDown: true })).toEqual({ standDown: true });
    expect(read({ staleHead: true })).toEqual({ staleHead: true });
  });

  it("refuses a missing or unparsable report", () => {
    expect(readDiagnosis(join(dir, "absent.json"))).toBeNull();
    expect(readDiagnosis(report("not json"))).toBeNull();
  });
});

describe("judgeReceipt", () => {
  it("refuses an unreadable report with what a receipt must hold", async () => {
    const receipt = await judge(null, stateWith([]));
    expect(receipt).toEqual({ refused: expect.stringContaining(INCOMPLETE) });
  });

  it("prefixes the diagnosis with its tracker issue without reading the state", async () => {
    let reads = 0;
    const receipt = await judgeReceipt(
      "999",
      HEAD,
      read({ diagnosis: "second try", issue: "#42" }),
      async () => {
        reads++;
        return null;
      },
    );
    expect(receipt).toEqual({
      text: "issue #42. second try",
      pushedHead: undefined,
    });
    expect(reads).toBe(0);
  });

  it("keeps the diagnosis of a filing parked during this diagnosis", async () => {
    const receipt = await judge(
      read({ diagnosis: "the local gate ran no tests", parked: FILING }),
      stateWith([park()]),
    );
    expect(receipt).toEqual({
      text: "no issue filed (parked for a person). the local gate ran no tests",
      pushedHead: undefined,
    });
  });

  it("refuses a filing park the drive does not hold", async () => {
    const receipt = await judge(
      read({ diagnosis: "done", parked: FILING }),
      stateWith([]),
    );
    expect(receipt).toEqual({
      refused: expect.stringContaining(
        `names the filing park ${FILING}, but this diagnosis parked no ${HUMAN_DECISION_CLASS} under that key`,
      ),
    });
  });

  it("refuses a park of another class or from before this diagnosis", async () => {
    const answer = read({ diagnosis: "done", parked: FILING });
    for (const held of [
      park({ class: "scope" }),
      park({ at: "2026-11-20T09:59:59.000Z" }),
      park({ key: "another-filing" }),
    ])
      expect(await judge(answer, stateWith([held]))).toEqual({
        refused: expect.stringContaining(`names the filing park ${FILING}`),
      });
  });

  it("refuses a parked filing when the drive state cannot be read", async () => {
    const receipt = await judge(
      read({ diagnosis: "done", parked: FILING }),
      null,
    );
    expect(receipt).toEqual({
      refused: expect.stringContaining("the drive state could not be read"),
    });
  });

  it("passes the stand-down marker through", async () => {
    expect(await judge({ standDown: true }, null)).toEqual({ standDown: true });
  });
});
