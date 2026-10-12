/**
 * outcome.test.ts
 *
 * Unit tests for `lib/outcome.ts`'s `hasLeaveOpenMarker` and
 * `hasNoOutcomeMarker` — plain functions, not subprocesses, so these are
 * direct in-process tests rather than spawning a script against fixture
 * files (the convention every other test in this directory uses, because
 * every other script under test IS a subprocess).
 */

import { describe, expect, it } from "bun:test";
import {
  hasLeaveOpenMarker,
  hasNoOutcomeMarker,
  LEAVE_OPEN_MARKER,
  NO_OUTCOME_MARKER,
} from "../scripts/lib/outcome.ts";

describe("hasLeaveOpenMarker", () => {
  it("recognizes the marker as the body's own dedicated trailing line", () => {
    expect(
      hasLeaveOpenMarker(`**wont-fix** — declined.\n\n${LEAVE_OPEN_MARKER}`),
    ).toBe(true);
  });

  it("recognizes it with a CRLF line terminator, mirroring qualifyingOutcome's own handling", () => {
    expect(
      hasLeaveOpenMarker(
        `**wont-fix** — declined.\r\n\r\n${LEAVE_OPEN_MARKER}\r\n`,
      ),
    ).toBe(true);
  });

  it("does NOT match an INDENTED example of the marker — an exact match only, no leading whitespace", () => {
    expect(
      hasLeaveOpenMarker(
        `**wont-fix** — the marker looks like this:\n\n    ${LEAVE_OPEN_MARKER}`,
      ),
    ).toBe(false);
  });

  it("does NOT match a PADDED example of the marker — trailing whitespace on the candidate line also disqualifies it", () => {
    expect(
      hasLeaveOpenMarker(`**wont-fix** — declined.\n\n${LEAVE_OPEN_MARKER}  `),
    ).toBe(false);
  });

  it("tolerates trailing blank lines after the marker", () => {
    expect(
      hasLeaveOpenMarker(
        `**wont-fix** — declined.\n\n${LEAVE_OPEN_MARKER}\n\n`,
      ),
    ).toBe(true);
  });

  it("does NOT match the marker text quoted mid-body — a trusted author explaining the mechanism must not accidentally trigger it", () => {
    expect(
      hasLeaveOpenMarker(
        `**wont-fix** — the reviewer flagged that ${LEAVE_OPEN_MARKER} exists, but that is not what this reply means.\n\nDeclining per the triage rubric.`,
      ),
    ).toBe(false);
  });

  it("does NOT match a body with no marker at all", () => {
    expect(hasLeaveOpenMarker("**wont-fix** — declined, no marker here.")).toBe(
      false,
    );
  });

  it("does NOT match an empty body", () => {
    expect(hasLeaveOpenMarker("")).toBe(false);
  });

  it("does NOT match a body that is blank lines only", () => {
    expect(hasLeaveOpenMarker("\n\n\n")).toBe(false);
  });
});

describe("hasNoOutcomeMarker", () => {
  it("recognizes the marker as the body's own dedicated trailing line", () => {
    expect(
      hasNoOutcomeMarker(
        `Which schema version is this pinned to?\n\n${NO_OUTCOME_MARKER}`,
      ),
    ).toBe(true);
  });

  it("does NOT match a body with no marker at all — a trusted author’s plain GitHub reply", () => {
    expect(hasNoOutcomeMarker("I agree; please fix this.")).toBe(false);
  });

  it("does NOT match an INDENTED example of the marker", () => {
    expect(
      hasNoOutcomeMarker(
        `The marker looks like this:\n\n    ${NO_OUTCOME_MARKER}`,
      ),
    ).toBe(false);
  });

  it("does NOT match an empty body", () => {
    expect(hasNoOutcomeMarker("")).toBe(false);
  });
});
