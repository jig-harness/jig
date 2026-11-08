/**
 * The priority a deferred finding files at, from its severity: one mapping
 * for every deferral path, `unknown` filed as medium, and each severity a
 * floor that raises a weaker priority and never lowers a stronger one.
 */
import { describe, expect, it } from "bun:test";
import {
  CANONICAL_SEVERITIES,
  SEVERITY_UNKNOWN,
} from "../scripts/lib/ladder.ts";
import {
  priorityAfterSeverity,
  priorityReflectsSeverity,
  priorityText,
  SEVERITY_TO_PRIORITY,
  severityPriority,
  urgency,
} from "../scripts/lib/severity-priority.ts";

const SEVERITIES = [...CANONICAL_SEVERITIES, SEVERITY_UNKNOWN];
const PRIORITIES = [0, 1, 2, 3, 4];

describe("SEVERITY_TO_PRIORITY", () => {
  it("files each severity at its priority, unknown as medium", () => {
    expect(SEVERITY_TO_PRIORITY).toEqual({
      unknown: 3,
      low: 4,
      medium: 3,
      high: 2,
      blocker: 1,
    });
  });

  it("covers exactly the severity vocabulary and unknown", () => {
    expect(Object.keys(SEVERITY_TO_PRIORITY).sort()).toEqual(
      [...SEVERITIES].sort(),
    );
  });

  it("refuses a token outside the vocabulary rather than filing no priority", () => {
    expect(() => severityPriority("critical")).toThrow(
      "Unknown severity 'critical'",
    );
    expect(() => severityPriority("constructor")).toThrow(
      "Unknown severity 'constructor'",
    );
  });
});

describe("urgency", () => {
  it("orders none below low below medium below high below urgent", () => {
    expect([0, 4, 3, 2, 1].map(urgency)).toEqual([0, 1, 2, 3, 4]);
  });

  it("reads a number outside the scale as none", () => {
    expect(urgency(5)).toBe(0);
    expect(urgency(-1)).toBe(0);
    expect(urgency(2.5)).toBe(0);
  });
});

describe("priorityReflectsSeverity", () => {
  it("is false when the priority is none and the severity is real", () => {
    expect(priorityReflectsSeverity(0, "high")).toBe(false);
  });

  it("is true when the priority is already as urgent or more", () => {
    expect(priorityReflectsSeverity(1, "high")).toBe(true);
    expect(priorityReflectsSeverity(2, "high")).toBe(true);
  });

  it("gives unknown the medium floor: none and low fall short of it", () => {
    expect(
      PRIORITIES.map((p) => priorityReflectsSeverity(p, "unknown")),
    ).toEqual([false, true, true, true, false]);
  });
});

describe("priorityAfterSeverity", () => {
  it("raises none and low to medium for an unknown severity, and keeps a stronger one", () => {
    expect(PRIORITIES.map((p) => priorityAfterSeverity(p, "unknown"))).toEqual([
      3, 1, 2, 3, 3,
    ]);
  });

  it("escalates a weaker priority to the severity's own", () => {
    expect(priorityAfterSeverity(0, "high")).toBe(2);
    expect(priorityAfterSeverity(4, "high")).toBe(2);
    expect(priorityAfterSeverity(3, "blocker")).toBe(1);
  });

  it("never lowers a priority already more urgent", () => {
    expect(priorityAfterSeverity(1, "medium")).toBe(1);
    expect(priorityAfterSeverity(2, "low")).toBe(2);
  });

  it("lands on a priority at least as urgent as both inputs, for every pair", () => {
    for (const severity of SEVERITIES)
      for (const p of PRIORITIES) {
        const result = priorityAfterSeverity(p, severity);
        expect(PRIORITIES).toContain(result);
        expect(priorityReflectsSeverity(result, severity)).toBe(true);
        expect(urgency(result)).toBeGreaterThanOrEqual(urgency(p));
      }
  });
});

describe("priorityText", () => {
  it("names the priority beside its number", () => {
    expect(priorityText(0)).toBe("0 (none)");
    expect(priorityText(3)).toBe("3 (medium)");
  });
});
