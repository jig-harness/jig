/**
 * The starter configuration: what it writes, what it leaves out, and that
 * what it writes always parses back into a configuration the schema accepts.
 */
import { describe, expect, test } from "bun:test";
import {
  checkConfig,
  loadSchema,
  parseSchema,
} from "../../skills/audit/scripts/lib/schema.ts";
import { draftConfig, type Fact } from "../detect.ts";
import { load } from "../yaml.ts";

/** The audit's configuration schema, the one a draft is checked against. */
const schema = loadSchema();

const fact = (field: string, value: unknown): Fact => ({
  field,
  value,
  evidence: [`seen: ${field}`],
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
        fact("review.bots", ["a-review"]),
        fact("gates.command", "make check"),
        fact("review.bots", ["b-review", "a-review"]),
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

  test("a list repeats no value, within one fact as across facts", () => {
    const only = draftConfig(
      [fact("review.bots", ["a-review", "a-review"])],
      schema,
      null,
    );
    expect(reread(only)).toEqual({ review: { bots: ["a-review"] } });
    const merged = draftConfig(
      [
        fact("review.bots", ["a-review"]),
        fact("review.bots", ["b-review", "b-review"]),
      ],
      schema,
      null,
    );
    expect(reread(merged)).toEqual({
      review: { bots: ["a-review", "b-review"] },
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
      [fact("review.bots", values), fact("repository.base_branch", "1.10")],
      schema,
      null,
    );
    expect(reread(draft)).toEqual({
      review: { bots: values },
      repository: { base_branch: "1.10" },
    });
  });

  test("leaves out defaults, unknown fields and fields the file already sets", () => {
    const facts = [
      fact("pull_requests.stacking", "none"),
      fact("pull_requests.mark_ready", 1),
      fact("pull_requests.issue_link", "refs"),
      fact("gates.comand", "make check"),
      fact("gates.command", "make check"),
    ];
    expect(reread(draftConfig(facts, schema, null))).toEqual({
      pull_requests: { issue_link: "refs" },
      gates: { command: "make check" },
    });
    const additions = draftConfig(facts, schema, {
      gates: { command: "bun run gates" },
    });
    expect(additions).toBe(
      "# Add to .config/jig.yaml:\npull_requests:\n  # seen: pull_requests.issue_link\n  issue_link: refs\n",
    );
    // An empty value sets nothing, so the draft still offers the field, as a
    // replacement of the null line: a second `command:` would be a duplicate.
    const replacing =
      draftConfig([fact("gates.command", "make check")], schema, {
        gates: { command: null },
      }) ?? "";
    expect(replacing).toContain(
      'command: "make check"   # the file sets this to null: replace that line',
    );
    expect(load(replacing)).toEqual({ gates: { command: "make check" } });
    // A field the file does not have at all is an addition, with no note.
    expect(
      draftConfig([fact("gates.command", "make check")], schema, {
        gates: {},
      }),
    ).not.toContain("replace that line");
    expect(
      draftConfig([fact("pull_requests.stacking", "none")], schema, null),
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
          fact("gates.command", "make check"),
          fact("review.bots", ["example-review[bot]"]),
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
});
