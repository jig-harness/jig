/** A factory-inherited pickup carries authority without pretending the factory is a served person. */
import { expect, test } from "bun:test";
import type { LaunchRecord } from "../lib/launches.ts";
import { pickupPassArgv } from "../lib/session.ts";

const record = {
  id: "20261110T000000Z-00000000",
  token: "0".repeat(32),
  action: "pickup",
  repo: "owner/repo",
  pr: null,
  item: "#1",
  vendor: "claude",
  model: null,
  effort: null,
  sessionId: null,
  factoryAncestor: "#2",
} as unknown as LaunchRecord;

test("a factory-inherited prompt requests the factory claim without served-person options", () => {
  const prompt = pickupPassArgv(record, []).at(-1) ?? "";
  expect(prompt).toContain("--factory-ancestor '#2'");
  expect(prompt).toContain("assign the child to the credential identity");
  expect(prompt).not.toContain("--for");
  expect(prompt).not.toContain("Claim this served assignment");
});

test("an interrupted pickup already claimed does not claim its factory child twice", () => {
  const prompt =
    pickupPassArgv({ ...record, stewardResume: "resume-1" }, []).at(-1) ?? "";
  expect(prompt).not.toContain("--factory-ancestor");
});
