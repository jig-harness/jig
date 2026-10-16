/**
 * `gh-conditional.ts` exists twice as a byte-identical PARITY COPY: in the
 * plugin's `shared/` and in drive-pr's `scripts/lib/`, each built on the
 * `proc.ts` beside it. Two copies of the code that decides whether a
 * rate-limited poll may be skipped is exactly the kind of thing that drifts
 * silently, so this pins them together. Behavioural coverage lives in
 * `shared/__tests__/gh-conditional.test.ts`, against the shared copy.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skills = join(here, "..", "..");
const COPIES = [
  join(skills, "drive-pr", "scripts", "lib", "gh-conditional.ts"),
  join(skills, "..", "shared", "gh-conditional.ts"),
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
