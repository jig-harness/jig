import { describe, expect, it } from "bun:test";
import { issueService, trackerProduct } from "../tracker-product.ts";

describe("a tracker's name for a person", () => {
  it("is the product an adapter names", () => {
    expect(trackerProduct("github")).toBe("GitHub Issues");
    expect(trackerProduct("Linear")).toBe("Linear");
    expect(trackerProduct("jira")).toBe("Jira");
    expect(trackerProduct("notion")).toBe("notion");
    expect(trackerProduct("constructor")).toBe("constructor");
  });

  it("falls back to the issue service, never the configuration's word", () => {
    expect(trackerProduct(null)).toBeNull();
    expect(trackerProduct(undefined)).toBeNull();
    expect(issueService(null)).toBe("the issue service");
    expect(issueService("jira")).toBe("Jira");
  });
});
