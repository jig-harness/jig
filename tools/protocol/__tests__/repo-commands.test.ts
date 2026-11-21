/**
 * The chapter on the commands a repository supplies reaches every input (M2
 * § Generators reach every input): the table it is generated from lists
 * exactly the settings the configuration schema types as a command,
 * enumerated here from the schema on its own, each with the schema's readers;
 * and the chapter renders every command and every exit the table holds.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "../../../lib/vendor/js-yaml.mjs";
import { REPO_COMMANDS } from "../../../plugin/shared/repo-commands.ts";
import { REPO_COMMANDS_CHAPTER } from "../chapters/repo-commands.ts";

const root = join(import.meta.dir, "..", "..", "..");

interface SchemaField {
  type?: string;
  items?: unknown;
  values_type?: unknown;
  read_by?: string[];
  repository_only?: boolean;
}

const schema = load(
  readFileSync(join(root, "plugin/skills/audit/config-schema.yaml"), "utf8"),
) as { fields: Record<string, SchemaField> };

/** A field whose value contains a command directly, in a list, or in a map. */
function holdsCommand(field: SchemaField): boolean {
  if (field.type === "command") return true;
  if (field.type === "map") return field.values_type === "command";
  if (field.type !== "list") return false;
  const items = field.items as
    | string
    | { type?: string; fields?: Record<string, unknown> }
    | undefined;
  if (items === "command") return true;
  if (typeof items !== "object" || items === null) return false;
  return (
    items.type === "command" ||
    Object.values(items.fields ?? {}).some(
      (t) =>
        t === "command" ||
        (typeof t === "object" &&
          t !== null &&
          (t as { type?: string }).type === "command"),
    )
  );
}

/**
 * The settings whose command Jig runs as words without a shell, which the
 * schema types as `any` since the value is a command line or a list of words.
 */
const ARGUMENT_LISTS = ["reflection.command"];

const commandFields = Object.entries(schema.fields).filter(
  ([path, f]) => holdsCommand(f) || ARGUMENT_LISTS.includes(path),
);

describe("the table of repository commands", () => {
  test("lists exactly the settings the configuration schema types as a command", () => {
    expect(Object.keys(REPO_COMMANDS).sort()).toEqual(
      commandFields.map(([path]) => path).sort(),
    );
  });

  test("names the schema's readers as each command's runners", () => {
    for (const [path, field] of commandFields)
      expect({
        path,
        runBy: [
          ...(REPO_COMMANDS[path as keyof typeof REPO_COMMANDS]
            .runBy as readonly string[]),
        ].sort(),
      }).toEqual({
        path,
        runBy: [...(field.read_by ?? [])].sort(),
      });
  });

  test("puts a command under the command store's rules only where the schema reads it from the repository's file alone", () => {
    for (const [path, field] of commandFields)
      if (REPO_COMMANDS[path as keyof typeof REPO_COMMANDS].commandStore)
        expect({ path, repositoryOnly: field.repository_only }).toEqual({
          path,
          repositoryOnly: true,
        });
  });
});

test("runs without a shell exactly the commands held as words", () => {
  expect(
    Object.entries(REPO_COMMANDS)
      .filter(([, c]) => !c.shell)
      .map(([path]) => path),
  ).toEqual(ARGUMENT_LISTS);
  for (const path of ARGUMENT_LISTS)
    expect(schema.fields[path]?.type).toBe("any");
});

describe("the chapter on the commands a repository supplies", () => {
  const values = REPO_COMMANDS_CHAPTER.values();
  const text = REPO_COMMANDS_CHAPTER.sections.map((s) => s.render()).join("\n");

  test("renders or explicitly leaves out every command of the table, and none both", () => {
    const ref = (n: string) =>
      `plugin/shared/repo-commands.ts#REPO_COMMANDS.${n}`;
    const names = Object.keys(REPO_COMMANDS).map(ref);
    const named = [
      ...REPO_COMMANDS_CHAPTER.takes(),
      ...REPO_COMMANDS_CHAPTER.excluded,
    ];
    expect(names.filter((n) => !named.includes(n))).toEqual([]);
    expect(named.filter((n) => !names.includes(n))).toEqual([]);
    expect(
      REPO_COMMANDS_CHAPTER.takes().filter((n) =>
        REPO_COMMANDS_CHAPTER.excluded.includes(n),
      ),
    ).toEqual([]);
  });

  test("lists every exit a command's caller tells apart, and no other", () => {
    expect(
      values
        .filter((v) => v.kind === "exit")
        .map((v) => `${v.setting}:${v.exit}`),
    ).toEqual(
      Object.entries(REPO_COMMANDS).flatMap(([name, c]) =>
        Object.keys(c.exits).map((exit) => `${name}:${exit}`),
      ),
    );
  });

  test("shows every command and every exit in its generated sections", () => {
    for (const v of values)
      expect(text).toContain(
        v.kind === "exit"
          ? `| \`${v.setting}\` | ${v.exit} |`
          : `| \`${v.setting}\` |`,
      );
  });
});
