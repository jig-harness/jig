import { describe, expect, it } from "bun:test";
import { releaseTag } from "../records/release-tags.ts";

describe("releaseTag", () => {
  it("accepts a safe reference prefix followed by a semantic version", () => {
    expect(releaseTag("releases/v1.2.3-rc.1+build.4")).toBe(true);
  });

  it("rejects a tag without a version suffix or with an unsafe prefix", () => {
    expect(releaseTag("releases/current")).toBe(false);
    expect(releaseTag("releases/+v1.2.3")).toBe(false);
  });
});
