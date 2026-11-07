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
  it("is off by default, with the jig: prefix", () => {
    expect(dispatchSection({}).labels).toEqual({
      enabled: false,
      prefix: "jig:",
      onlyLabeled: false,
    });
  });

  it("reads a prefix of the repository's own", () => {
    expect(
      dispatchSection({
        dispatch: {
          labels: { enabled: true, prefix: "bot/", only_labeled: true },
        },
      }).labels,
    ).toEqual({ enabled: true, prefix: "bot/", onlyLabeled: true });
  });

  it("refuses an unknown key, a prefix gh would split or the forge would cut, and only_labeled with the labels off", () => {
    const read = (labels: unknown) => () =>
      dispatchSection({ dispatch: { labels } });
    expect(read({ enabled: true, colour: "red" })).toThrow(
      "dispatch.labels has unknown key(s): colour",
    );
    expect(read({ enabled: true, prefix: "a,b" })).toThrow("no comma");
    expect(read({ enabled: true, prefix: "x".repeat(40) })).toThrow(
      "at most 39 characters",
    );
    expect(read({ enabled: "yes" })).toThrow("must be true or false");
    expect(read({ only_labeled: true })).toThrow(
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
      "bot/drive",
      "bot/rearm",
      "bot/hold",
    ]);
  });
});

describe("the label set", () => {
  it("describes each label within the 100 characters the forge takes", () => {
    const tooLong = labelSet(ON).filter((l) => l.description.length > 100);
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
