import { describe, expect, it } from "bun:test";
import { trackerName } from "./tracker-name.ts";

describe("a repository's tracker on the page", () => {
  it("is named as the product a person knows", () => {
    expect(trackerName({ adapter: "github" })).toBe("GitHub Issues");
    expect(trackerName({ adapter: "linear" })).toBe("Linear");
    expect(trackerName({ adapter: "jira" })).toBe("Jira");
    expect(trackerName({ adapter: "Jira" })).toBe("Jira");
  });

  it("keeps an adapter it does not know by the configuration's own word", () => {
    expect(trackerName({ adapter: "notion" })).toBe("notion");
  });

  it("is not named when the line does not say", () => {
    expect(trackerName(null)).toBeNull();
    expect(trackerName(undefined)).toBeNull();
  });
});
