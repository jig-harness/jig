import { expect, it } from "bun:test";
import { asResult } from "../lib/launch-result.ts";

it("reads a failed row with an unreadable wait time or decision as a failure", () => {
  expect(asResult("failed", "not a time", null)).toBe("failed");
  expect(asResult("failed", null, "{}")).toBe("failed");
  expect(asResult("failed", null, "not json")).toBe("failed");
});

it("reads a failed row with a time as a wait", () => {
  expect(asResult("failed", "2026-11-18T09:34:22.646Z", null)).toBe("waits");
});

it("reads done and a bare failed as themselves", () => {
  expect(asResult("done")).toBe("done");
  expect(asResult("failed")).toBe("failed");
});
