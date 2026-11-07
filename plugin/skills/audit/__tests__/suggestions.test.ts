/**
 * The configuration fit's suggestions: the id of each one's finding, and that
 * a suggestion answering another finding still drafts like any other.
 */
import { describe, expect, test } from "bun:test";
import { draftConfig } from "../../../shared/detect.ts";
import { load } from "../../../shared/yaml.ts";
import { checkConfig, loadSchema } from "../scripts/lib/schema.ts";
import {
  type Suggestion,
  suggestedFacts,
  suggestionId,
} from "../scripts/lib/suggestions.ts";

const schema = loadSchema();

const suggest = (field: string, value: unknown, key?: string): Suggestion => ({
  field,
  value,
  evidence: `seen: ${field}`,
  message: `set ${field}`,
  ...(key === undefined ? {} : { key }),
});

/** Parse a draft back and check it as the audit checks a repository's file. */
function reread(draft: string | undefined): Record<string, unknown> {
  const parsed = load(draft ?? "") as Record<string, unknown> | null;
  expect(checkConfig(parsed ?? {}, schema)).toEqual([]);
  return parsed ?? {};
}

describe("the configuration fit's suggestions", () => {
  test("a value that answers another finding takes that finding's id", () => {
    const stacking: Suggestion = {
      ...suggest("pull_requests.stacking", "branch"),
      id: "contradiction:pull_requests.stacking",
    };
    expect(suggestionId(stacking)).toBe("contradiction:pull_requests.stacking");
    expect(suggestionId(suggest("review.bots", ["a"], "a"))).toBe(
      "suggestion:review.bots:a",
    );
    expect(
      reread(
        draftConfig(
          suggestedFacts([
            stacking,
            suggest("review.repo_slug", "example/web"),
          ]),
          schema,
          null,
        ),
      ),
    ).toEqual({
      pull_requests: { stacking: "branch" },
      review: { repo_slug: "example/web" },
    });
  });
});
