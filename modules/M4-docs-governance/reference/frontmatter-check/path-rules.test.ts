import { beforeAll, describe, expect, test } from "bun:test";
import type { FieldValue } from "../docs";
import { load } from "../../../../lib/vendor/js-yaml.mjs";
import {
  applyPathRules,
  bodyOutsideFences,
  type PathRule,
  readPathRules,
  rulePath,
} from "./path-rules";

/** Rules from schema text, parsed as the checker parses it. */
async function loadPathRules(text: string) {
  try {
    return readPathRules(load(text));
  } catch (error) {
    return { rules: [], errors: [`schema is not valid YAML: ${error}`] };
  }
}

const schema = (rules: string) =>
  `status:\n  values: [draft, archived]\nrequired:\n  - title\npath_rules:\n${rules}`;

describe("loadPathRules", () => {
  test("a schema without path_rules has no rules and no errors", async () => {
    expect(await loadPathRules("required:\n  - title\n")).toEqual({
      rules: [],
      errors: [],
    });
  });

  test("a quoted or spaced path_rules key still loads its rules", async () => {
    const rule =
      "  - id: a\n    paths: [docs/a/]\n    allowed_values:\n      status: [archived]\n";
    for (const key of ['"path_rules":', "'path_rules':", "path_rules :"]) {
      const { rules, errors } = await loadPathRules(
        schema(rule).replace("path_rules:", key),
      );
      expect(errors).toEqual([]);
      expect(rules.map((r) => r.id)).toEqual(["a"]);
    }
  });

  test("any YAML spelling of the key is found, since the key is looked up after parsing", async () => {
    const rule =
      "  - id: a\n    paths: [docs/a/]\n    allowed_values:\n      status: [archived]\n";
    for (const key of ['"\\x70ath_rules":', "? path_rules\n:"]) {
      const { rules, errors } = await loadPathRules(
        schema(rule).replace("path_rules:", key),
      );
      expect(errors).toEqual([]);
      expect(rules.map((r) => r.id)).toEqual(["a"]);
    }
  });

  test("a well-formed rule loads", async () => {
    const { rules, errors } = await loadPathRules(
      schema(
        "  - id: a\n    paths: [docs/a/]\n    allowed_values:\n      status: [archived]\n",
      ),
    );
    expect(errors).toEqual([]);
    expect(rules[0]?.allowedValues.get("status")).toEqual(["archived"]);
  });

  const broken: [string, string, string][] = [
    ["not a list", "  id: a\n", "'path_rules' must be a list of rules"],
    ["not a mapping", "  - just text\n", "rule #0: must be a mapping"],
    [
      "no id",
      "  - paths: [docs/]\n    required_fields: [x]\n",
      "needs an 'id'",
    ],
    [
      "no paths",
      "  - id: a\n    required_fields: [x]\n",
      "'paths' must be a non-empty list",
    ],
    [
      "absolute prefix",
      "  - id: a\n    paths: [/docs/]\n    required_fields: [x]\n",
      "not a normalised",
    ],
    [
      "escaping prefix",
      "  - id: a\n    paths: [../docs/]\n    required_fields: [x]\n",
      "not a normalised",
    ],
    [
      "no restriction",
      "  - id: a\n    paths: [docs/]\n",
      "declares no restriction",
    ],
    [
      "message not text",
      "  - id: a\n    paths: [docs/]\n    message: [x]\n    required_fields: [x]\n",
      "'message' must be text",
    ],
    [
      "required not a list",
      "  - id: a\n    paths: [docs/]\n    required_fields: x\n",
      "'required_fields' must be a non-empty list",
    ],
    [
      "allowed not a mapping",
      "  - id: a\n    paths: [docs/]\n    allowed_values: [x]\n",
      "'allowed_values' must be a non-empty mapping",
    ],
    [
      "allowed values an empty mapping",
      "  - id: a\n    paths: [docs/]\n    required_fields: [x]\n    allowed_values: {}\n",
      "'allowed_values' must be a non-empty mapping",
    ],
    [
      "forbidden patterns an empty list",
      "  - id: a\n    paths: [docs/]\n    required_fields: [x]\n    forbidden_body_patterns: []\n",
      "'forbidden_body_patterns' must be a non-empty list",
    ],
    [
      "pattern message not text",
      "  - id: a\n    paths: [docs/]\n    forbidden_body_patterns:\n      - id: p\n        pattern: TODO\n        message: [no, TODO]\n",
      "forbidden_body_patterns[0] 'message' must be text",
    ],
    [
      "allowed values empty",
      "  - id: a\n    paths: [docs/]\n    allowed_values:\n      status: []\n",
      "must be a non-empty list of values",
    ],
    [
      "allowed field unknown",
      "  - id: a\n    paths: [docs/]\n    allowed_values:\n      stauts: [draft]\n",
      "names 'stauts'",
    ],
    [
      "a number is not a value",
      "  - id: a\n    paths: [docs/]\n    allowed_values:\n      status: [1]\n",
      "must be a non-empty list of values",
    ],
    [
      "patterns not a list",
      "  - id: a\n    paths: [docs/]\n    forbidden_body_patterns: x\n",
      "'forbidden_body_patterns' must be a non-empty list",
    ],
    [
      "pattern without id",
      "  - id: a\n    paths: [docs/]\n    forbidden_body_patterns:\n      - pattern: x\n",
      "needs an 'id' and a 'pattern'",
    ],
    [
      "pattern unknown key",
      "  - id: a\n    paths: [docs/]\n    forbidden_body_patterns:\n      - id: p\n        pattern: x\n        flags: i\n",
      "unknown key 'flags'",
    ],
    [
      "duplicate key",
      "  - id: a\n    id: b\n    paths: [docs/]\n    required_fields: [x]\n",
      "schema is not valid YAML",
    ],
  ];
  for (const [label, rules, message] of broken)
    test(`fails closed: ${label}`, async () => {
      expect((await loadPathRules(schema(rules))).errors.join("\n")).toContain(
        message,
      );
    });

  test("a field declared only under type_specific may be narrowed", async () => {
    const { errors } = await loadPathRules(
      `type_specific:\n  adr:\n    - supersedes\n${schema(
        "  - id: a\n    paths: [docs/]\n    allowed_values:\n      supersedes: [ADR-1]\n",
      )}`,
    );
    expect(errors).toEqual([]);
  });

  test("a field the rule requires may be narrowed", async () => {
    const { errors } = await loadPathRules(
      schema(
        "  - id: a\n    paths: [docs/]\n    required_fields: [service]\n    allowed_values:\n      service: [cache, queue]\n",
      ),
    );
    expect(errors).toEqual([]);
  });
});

describe("bodyOutsideFences", () => {
  const lines = [
    "a",
    "```js",
    "hidden",
    "``",
    "still hidden",
    "````",
    "b",
    "    ```",
    "c",
    "~~~",
    "hidden",
    "```",
    "~~~~",
    "``` not `a` fence",
    "d",
  ];
  test("skips fenced lines, CommonMark-style", () => {
    expect(bodyOutsideFences(lines, 0)).toEqual([
      [1, "a"],
      [7, "b"],
      [8, "    ```"],
      [9, "c"],
      [14, "``` not `a` fence"],
      [15, "d"],
    ]);
  });
  test("an unclosed fence hides the rest of the document", () => {
    expect(bodyOutsideFences(["x", "```", "y"], 0)).toEqual([[1, "x"]]);
  });
});

describe("applyPathRules", () => {
  let rules: PathRule[] = [];
  beforeAll(async () => {
    ({ rules } = await loadPathRules(
      schema(
        "  - id: a\n    paths: [docs/a/]\n    required_fields: [owner]\n    allowed_values:\n      status: [archived]\n    forbidden_body_patterns:\n      - id: p\n        pattern: TODO\n        message: no TODO\n",
      ),
    ));
  });
  test("only documents under a prefix are judged", () => {
    expect(
      applyPathRules(rules, "docs/b/x.md", new Map(), [[5, "TODO"]]),
    ).toEqual([]);
  });
  test("a list value is judged member by member", () => {
    const errors = applyPathRules(
      rules,
      "docs/a/x.md",
      new Map<string, FieldValue>([
        ["owner", "docs"],
        ["status", ["archived", "draft"]],
      ]),
      [],
    );
    expect(errors).toEqual([
      "status 'draft' is not allowed here (allowed: archived) (path rule 'a')",
    ]);
  });
  test("a required field must hold content: an empty or blank list is missing", () => {
    for (const owner of [[], [" "]] as FieldValue[])
      expect(
        applyPathRules(rules, "docs/a/x.md", new Map([["owner", owner]]), []),
      ).toEqual(["missing required field: owner (path rule 'a')"]);
    expect(
      applyPathRules(rules, "docs/a/x.md", new Map([["owner", ["docs"]]]), []),
    ).toEqual([]);
  });
  test("rulePath is repository-relative with / separators", () => {
    expect(rulePath("./docs/a/x.md", "/repo")).toBe("docs/a/x.md");
    expect(rulePath("/repo/docs/a/x.md", "/repo")).toBe("docs/a/x.md");
  });
});
