/**
 * The dispatch labels' pure part: `dispatch.labels` read from a
 * repository's section, the state each ledger class maps to, and what the
 * projection changes on one pull request.
 */
import { describe, expect, it } from "bun:test";
import {
  labelChange,
  labelSet,
  type LabelConfig,
  stateOf,
} from "../lib/labels.ts";
import { markerSet } from "../lib/pr-markers.ts";
import { dispatchSection } from "../lib/section.ts";
import type { DrivenPr, LedgerClass } from "../lib/types.ts";

const ON: LabelConfig = { enabled: true, prefix: "jig:", onlyLabeled: false };

const drive = (cls: LedgerClass, exit: number | null = null): DrivenPr => ({
  number: 7,
  url: "",
  title: "",
  head: "feature/7",
  class: cls,
  why: "",
  evidence: { exit },
});

describe("dispatch.labels", () => {
  /** The section read from `dispatch`, which the test expects to validate. */
  const section = (dispatch: unknown) => {
    const read = dispatchSection({ dispatch });
    if (!read.ok) throw new Error(read.failure.reason);
    return read.value;
  };

  it("accepts the drive-owned recipient setting", () => {
    expect(dispatchSection({ dispatch: { person: "maintainer" } }).ok).toBe(
      true,
    );
  });
  it("is off by default, with the jig: prefix", () => {
    expect(section(undefined).labels).toEqual({
      enabled: false,
      prefix: "jig:",
      onlyLabeled: false,
    });
  });

  it("reads a prefix of the repository's own", () => {
    expect(
      section({
        labels: { enabled: true, prefix: "bot/", only_labeled: true },
      }).labels,
    ).toEqual({ enabled: true, prefix: "bot/", onlyLabeled: true });
  });

  it("refuses an unknown key, a prefix gh would split or the forge would cut, and only_labeled with the labels off", () => {
    const refusal = (labels: unknown, reason: string) =>
      expect(dispatchSection({ dispatch: { labels } })).toEqual({
        ok: false,
        failure: { code: "invalid", reason: expect.stringContaining(reason) },
      });
    refusal(
      { enabled: true, colour: "red" },
      "dispatch.labels has unknown key(s): colour",
    );
    refusal({ enabled: true, prefix: "a,b" }, "no comma");
    refusal({ enabled: true, prefix: "x".repeat(36) }, "at most 35 characters");
    refusal({ enabled: true, prefix: "automation:x-" }, "automation:");
    refusal({ enabled: "yes" }, "must be true or false");
    refusal(
      { only_labeled: true },
      "only_labeled needs dispatch.labels.enabled",
    );
  });
});

describe("the label set", () => {
  it("puts the prefix before every state and command", () => {
    expect(labelSet({ ...ON, prefix: "bot/" }).map((l) => l.name)).toEqual([
      "bot/driving",
      "bot/converged",
      "bot/parked",
      "bot/stale",
      "bot/held",
      "bot/followed-up",
      "bot/followup-failed",
      "bot/drive",
      "bot/rearm",
      "bot/hold",
    ]);
  });
});

describe("the label set", () => {
  it("colors converged differently from driving", () => {
    const color = (name: string) =>
      labelSet(ON).find((l) => l.name === name)?.color;
    expect(color("jig:converged")).toBe("0e8a16");
    expect(color("jig:converged")).not.toBe(color("jig:driving"));
  });

  it("colors parked red, apart from driving and converged", () => {
    const color = (name: string) =>
      labelSet(ON).find((l) => l.name === name)?.color;
    expect(color("jig:parked")).toBe("d93f0b");
    expect(color("jig:parked")).not.toBe(color("jig:driving"));
    expect(color("jig:parked")).not.toBe(color("jig:converged"));
  });

  it("colors a failed follow-up the parked red: a person acts on both", () => {
    const failed = labelSet(ON).find((l) => l.name === "jig:followup-failed");
    expect(failed?.color).toBe("d93f0b");
    expect(failed?.description).toBe(
      "Merged, and its follow-up failed: a person acts",
    );
  });
});

describe("the marker set", () => {
  it("colors the manual-operations marker purple: a pending step is not a stop", () => {
    const color = (name: string) =>
      [...labelSet(ON), ...markerSet("manual-ops")].find((l) => l.name === name)
        ?.color;
    expect(color("manual-ops")).toBe("5319e7");
    expect(color("manual-ops")).not.toBe(color("jig:parked"));
    expect(color("manual-ops")).not.toBe(color("jig:followup-failed"));
  });
});

describe("the label set", () => {
  it("describes each label within the 100 characters the forge takes", () => {
    const tooLong = [...labelSet(ON), ...markerSet("manual-ops")].filter(
      (l) => l.description.length > 100,
    );
    expect(tooLong.map((l) => l.name)).toEqual([]);
  });
});

describe("the state a ledger maps to", () => {
  it("follows the ledger's class, and leaves a ledger it cannot read as it is", () => {
    expect(stateOf(drive("driven"))).toEqual({ state: "driving" });
    expect(stateOf(drive("re-armable"))).toEqual({ state: "driving" });
    expect(stateOf(drive("stale"))).toEqual({ state: "stale" });
    expect(stateOf(drive("parked"))).toEqual({ state: "parked" });
    expect(stateOf(drive("needs-person"))).toEqual({ state: "parked" });
    expect(stateOf(drive("done", 0))).toEqual({ state: "converged" });
    expect(stateOf(drive("done", 20))).toEqual({ state: "driving" });
    expect(stateOf(drive("done", 5))).toBe("unknown");
    expect(stateOf(drive("unplaced"))).toBe("unknown");
    expect(stateOf(drive("unarmed"))).toEqual({ state: null });
    expect(stateOf(undefined)).toEqual({ state: null });
  });
});

describe("what the projection changes", () => {
  it("replaces another state label and keeps every other label", () => {
    expect(
      labelChange(ON, 7, ["bug", "jig:parked"], { state: "converged" }, false),
    ).toEqual({ pr: 7, add: ["jig:converged"], remove: ["jig:parked"] });
    expect(labelChange(ON, 7, ["jig:held"], { state: "stale" }, false)).toEqual(
      { pr: 7, add: ["jig:stale"], remove: ["jig:held"] },
    );
  });

  it("changes nothing where the labels agree", () => {
    expect(
      labelChange(ON, 7, ["jig:driving"], { state: "driving" }, true),
    ).toBeNull();
  });

  it("removes a drive label only once it has been carried out, and never a hold label", () => {
    expect(
      labelChange(ON, 7, ["jig:drive", "jig:hold"], { state: "driving" }, true),
    ).toEqual({ pr: 7, add: ["jig:driving"], remove: ["jig:drive"] });
    expect(
      labelChange(ON, 7, ["jig:drive", "jig:hold"], { state: null }, false),
    ).toBeNull();
  });

  it("leaves the state labels alone when the state is unknown, and a label the projection does not own always", () => {
    expect(
      labelChange(ON, 7, ["jig:stale", "jig:queued"], "unknown", false),
    ).toBeNull();
    expect(
      labelChange(ON, 7, ["jig:queued"], { state: "driving" }, false),
    ).toEqual({ pr: 7, add: ["jig:driving"], remove: [] });
  });
});
