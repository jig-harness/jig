import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewConfig } from "../scripts/lib/consumer.ts";

function withOverlay(value: unknown, check: () => void): void {
  const directory = mkdtempSync(join(tmpdir(), "review-consumer-"));
  const previous = process.env.JIG_OVERLAY;
  try {
    const path = join(directory, "overlay.json");
    writeFileSync(path, JSON.stringify(value));
    process.env.JIG_OVERLAY = path;
    check();
  } finally {
    if (previous === undefined) delete process.env.JIG_OVERLAY;
    else process.env.JIG_OVERLAY = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [field, tokens] of [
  ["context_prefixes", ["owner:", "area:"]],
  ["types", ["bug"]],
  ["repos", ["project"]],
] as const)
  test(`declaring ${field} cannot silently disable batch ownership checks`, () => {
    withOverlay({ review: { taxonomy: { [field]: tokens } } }, () => {
      expect(reviewConfig).toThrow("ownership_prefixes is required");
    });
  });

test("an empty ownership set cannot disable the same checks", () => {
  withOverlay(
    {
      review: {
        taxonomy: { context_prefixes: ["owner:"], ownership_prefixes: [] },
      },
    },
    () =>
      expect(reviewConfig).toThrow(
        "ownership_prefixes must contain distinct nonempty strings",
      ),
  );
});

test("a consumer can declare its own ownership prefixes", () => {
  const taxonomy = {
    context_prefixes: ["owner:", "area:"],
    ownership_prefixes: ["owner:"],
    types: ["bug"],
    repos: ["project"],
  };
  withOverlay({ review: { taxonomy } }, () => {
    expect(reviewConfig().taxonomy).toEqual(taxonomy);
  });
});

test("non-deferral consumers do not need a batching taxonomy", () => {
  withOverlay({ review: { bots: ["review-bot[bot]"] } }, () => {
    expect(reviewConfig()).toEqual({ bots: ["review-bot[bot]"] });
  });
  withOverlay({}, () => expect(reviewConfig()).toEqual({}));
});

for (const value of [[], "AI review", [""], [" "], [42], ["review", "review"]])
  test(`invalid required check names fail closed: ${JSON.stringify(value)}`, () => {
    withOverlay({ review: { required_checks: value } }, () => {
      expect(reviewConfig).toThrow(
        "review.required_checks must contain distinct nonempty check names",
      );
    });
  });

test("required check names come from consumer policy", () => {
  withOverlay({ review: { required_checks: ["custom-check"] } }, () => {
    expect(reviewConfig().required_checks).toEqual(["custom-check"]);
  });
});
