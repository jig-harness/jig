import { describe, expect, it } from "bun:test";
import { itemWords, trackerName } from "./tracker-name.ts";

describe("a repository's tracker on the page", () => {
  it("is named as the product a person knows", () => {
    expect(trackerName({ adapter: "github" })).toBe("GitHub Issues");
    expect(trackerName({ adapter: "linear" })).toBe("Linear");
    expect(trackerName({ adapter: "jira" })).toBe("Jira");
    expect(trackerName({ adapter: "Jira" })).toBe("Jira");
  });

  it("keeps an adapter it does not know by the configuration's own word", () => {
    expect(trackerName({ adapter: "notion" })).toBe("notion");
    expect(trackerName({ adapter: "constructor" })).toBe("constructor");
    expect(trackerName({ adapter: "__proto__" })).toBe("__proto__");
  });

  it("is not named when the line does not say", () => {
    expect(trackerName(null)).toBeNull();
    expect(trackerName(undefined)).toBeNull();
  });
});

describe("an item's words", () => {
  it("name the product and where its link goes", () => {
    expect(itemWords({ adapter: "linear" })).toMatchObject({
      kind: "Linear issue",
      open: "Open in Linear",
      unnamed: null,
    });
    expect(itemWords({ adapter: "github" })).toMatchObject({
      kind: "GitHub issue",
      open: "Open on GitHub",
    });
    expect(itemWords({ adapter: "notion" })).toMatchObject({
      kind: "notion issue",
      open: "Open in notion",
    });
  });

  it("fall back to neutral words that never say tracker", () => {
    for (const tracker of [null, undefined]) {
      const words = itemWords(tracker);
      expect(words.kind).toBe("Issue");
      expect(words.open).toBe("Open the issue");
      expect(JSON.stringify(words)).not.toMatch(/tracker/i);
    }
  });
});
