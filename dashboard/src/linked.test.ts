import { describe, expect, it } from "bun:test";
import { LINKED_WORDS, linkedWork } from "./linked.ts";

describe("a card's linked work", () => {
  it("is not known when the line does not say", () => {
    const linked = linkedWork("PR #7", undefined);
    expect(linked.state).toBe("unknown");
    expect(linked.sentence).toBe("not known for this read.");
    expect(linked.shown).toEqual([]);
  });

  it("is none found when the line found none, worded for a pull request and for an item", () => {
    const none = { items: [], prs: [] };
    expect(linkedWork("PR #7", none)).toMatchObject({
      state: "none",
      sentence: LINKED_WORDS.nonePr,
    });
    expect(linkedWork("ENG-4", none).sentence).toBe(
      "none found among this repository's open pull requests.",
    );
  });

  it("shows two on the face and leaves the rest to +N more", () => {
    const linked = linkedWork("PR #7", {
      items: [
        { key: "ENG-1", url: "https://issues.example/ENG-1" },
        { key: "ENG-2", url: null },
        { key: "ENG-3", url: null },
      ],
      prs: [],
    });
    expect(linked.state).toBe("some");
    expect(linked.shown.map((r) => r.target)).toEqual(["ENG-1", "ENG-2"]);
    expect(linked.more).toBe(1);
    expect(linked.all).toHaveLength(3);
  });

  it("names an item's pull requests as pull requests, and leaves itself and repeats out", () => {
    const linked = linkedWork("ENG-4", {
      items: [{ key: "ENG-4", url: null }],
      prs: [
        { number: 12, url: "https://forge.example/o/r/pull/12" },
        { number: 12, url: "https://forge.example/o/r/pull/12" },
      ],
    });
    expect(linked.all).toEqual([
      { target: "PR #12", url: "https://forge.example/o/r/pull/12", pr: true },
    ]);
    expect(linked.more).toBe(0);
  });
});
