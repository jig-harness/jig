/**
 * `lib/gh-conditional.ts` exists in two skills as a byte-identical PARITY COPY
 *: each skill ships standalone, so neither imports the other's lib —
 * the boundary `lib/proc.ts` documents. Two copies of the code that decides
 * whether a rate-limited poll may be skipped is exactly the kind of thing that
 * drifts silently, so this pins them together. Behavioural coverage lives in
 * `resolve-review-comments/__tests__/gh-conditional.test.ts`, against the
 * canonical copy.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skills = join(here, "..", "..");
const COPIES = [
  join(skills, "drive-pr", "scripts", "lib", "gh-conditional.ts"),
  join(
    skills,
    "resolve-review-comments",
    "scripts",
    "lib",
    "gh-conditional.ts",
  ),
];

describe("gh-conditional.ts parity copies", () => {
  it("both copies exist (a missing copy must fail, not vacuously match)", () => {
    for (const f of COPIES) expect(existsSync(f)).toBe(true);
  });

  it("are byte-identical", () => {
    const [a, b] = COPIES.map((f) => readFileSync(f, "utf8"));
    // A non-trivial body, so two empty reads cannot agree.
    expect((a ?? "").length).toBeGreaterThan(1000);
    expect(a).toBe(b);
  });
});
