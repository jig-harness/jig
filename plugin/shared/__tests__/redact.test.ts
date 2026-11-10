import { expect, test } from "bun:test";
import { redact } from "../redact.ts";

test("redacts email addresses while preserving trailing prose punctuation", () => {
  expect(redact("Notify alice@example.test.")).toBe("Notify <redacted>.");
  expect(redact("Notify alice@example.test...")).toBe("Notify <redacted>...");
  expect(redact("Notify alice@example.test...then wait.")).toBe(
    "Notify <redacted>...then wait.",
  );
});
