/**
 * The starter configuration: what it writes, what it leaves out, and that
 * what it writes always parses back into a configuration the schema accepts.
 */
import { describe, expect, test } from "bun:test";
import { load } from "../../../shared/yaml.ts";
import {
  draftConfig,
  type Suggestion,
  suggestionId,
} from "../scripts/lib/draft.ts";
import { checkConfig, loadSchema, parseSchema } from "../scripts/lib/schema.ts";

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

describe("the starter configuration", () => {
  test("nests each field under its section with its evidence above it", () => {
    const draft = draftConfig(
      [
        suggest("review.bots", ["a-review"], "a-review"),
        suggest("gates.command", "make check"),
        suggest("review.bots", ["b-review", "a-review"], "b-review"),
      ],
      schema,
      null,
    );
    expect(draft).toEndWith(`
review:
  # seen: review.bots
  # seen: review.bots
  bots: [a-review, b-review]
gates:
  # seen: gates.command
  command: "make check"
`);
    expect(reread(draft)).toEqual({
      review: { bots: ["a-review", "b-review"] },
      gates: { command: "make check" },
    });
  });

  test("quotes what YAML would read as something other than the text", () => {
    const values = [
      "yes",
      "null",
      "1.10",
      "bun run gates && make: all",
      "#comment",
      'say "hi"',
      "ai-review[bot]",
    ];
    const draft = draftConfig(
      [
        suggest("review.bots", values),
        suggest("repository.base_branch", "1.10"),
      ],
      schema,
      null,
    );
    expect(reread(draft)).toEqual({
      review: { bots: values },
      repository: { base_branch: "1.10" },
    });
  });

  test("leaves out defaults, unknown fields and fields the file already sets", () => {
    const suggestions = [
      suggest("pull_requests.stacking", "none"),
      suggest("pull_requests.mark_ready", 1),
      suggest("pull_requests.issue_link", "refs"),
      suggest("gates.comand", "make check"),
      suggest("gates.command", "make check"),
    ];
    expect(reread(draftConfig(suggestions, schema, null))).toEqual({
      pull_requests: { issue_link: "refs" },
      gates: { command: "make check" },
    });
    const additions = draftConfig(suggestions, schema, {
      gates: { command: "bun run gates" },
    });
    expect(additions).toBe(
      "# Add to .config/jig.yaml:\npull_requests:\n  # seen: pull_requests.issue_link\n  issue_link: refs\n",
    );
    expect(
      draftConfig([suggest("pull_requests.stacking", "none")], schema, null),
    ).toBeUndefined();
  });

  test("an addition to a section the file has says to merge it there", () => {
    const schema = parseSchema({
      version: 1,
      strict: [],
      refused: {},
      fields: {
        "gates.command": { type: "command", read_by: ["x"] },
        "review.bots": { type: "list", items: "string", read_by: ["x"] },
      },
    });
    const additions =
      draftConfig(
        [
          suggest("gates.command", "make check"),
          suggest("review.bots", ["example-review[bot]"]),
        ],
        schema,
        { review: { sticky_marker: "x" } },
      ) ?? "";
    expect(additions).toContain(
      "review:   # the file has this section: add the fields under it",
    );
    expect(additions).toContain("\ngates:\n");
    // Still YAML, so it reads back as the fields it adds.
    expect(load(additions)).toEqual({
      review: { bots: ["example-review[bot]"] },
      gates: { command: "make check" },
    });
  });

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
          [stacking, suggest("review.repo_slug", "example/web")],
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
