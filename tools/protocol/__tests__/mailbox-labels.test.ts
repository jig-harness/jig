/**
 * The mailbox and pull-request label chapters reach every input (M2 §
 * Generators reach every input): each renders or explicitly leaves out every
 * entry of the tables it draws from, enumerated here on their own, and shows
 * each one it renders in a generated section.
 */
import { describe, expect, test } from "bun:test";
import {
  COMMANDS,
  DEFAULT_LABELS,
  labelSet,
  PROJECTED_STATES,
} from "../../../plugin/shared/pr-labels/projection.ts";
import {
  DIRECTIVE_COMMANDS,
  INBOX_FIELDS,
  MESSAGE_KINDS,
  OUTBOX_FIELDS,
  OUTBOX_STATUSES,
} from "../../../plugin/skills/drive-pr/scripts/lib/state/mailbox-values.ts";
import type { Chapter } from "../chapter.ts";
import { MAILBOX } from "../chapters/mailbox.ts";
import { PR_LABELS } from "../chapters/pr-labels.ts";

const sectionsOf = (chapter: Chapter) =>
  chapter.sections.map((s) => s.render()).join("\n");

/** The entries of `table` the chapter neither takes nor leaves out, and the ones it names that `table` lacks. */
function reach(
  chapter: Chapter,
  file: string,
  table: string,
  names: readonly string[],
) {
  const ref = (n: string) => `${file}#${table}.${n}`;
  const named = [...chapter.takes(), ...chapter.excluded].filter((r) =>
    r.startsWith(`${file}#${table}.`),
  );
  return {
    missed: names.map(ref).filter((r) => !named.includes(r)),
    unknown: named.filter((r) => !names.map(ref).includes(r)),
    both: chapter.takes().filter((r) => chapter.excluded.includes(r)),
  };
}

const NONE = { missed: [], unknown: [], both: [] };

describe("the drive mailbox", () => {
  const file = "plugin/skills/drive-pr/scripts/lib/state/mailbox-values.ts";
  const tables: Record<string, readonly string[]> = {
    MESSAGE_KINDS: Object.keys(MESSAGE_KINDS),
    // The commands the mailbox's parser and command line read.
    MAILBOX_DIRECTIVES: DIRECTIVE_COMMANDS,
    OUTBOX_STATUSES: Object.keys(OUTBOX_STATUSES),
    INBOX_FIELDS: Object.keys(INBOX_FIELDS),
    OUTBOX_FIELDS: Object.keys(OUTBOX_FIELDS),
  };

  for (const [table, names] of Object.entries(tables))
    test(`renders or explicitly leaves out every entry of ${table}`, () => {
      expect(reach(MAILBOX, file, table, names)).toEqual(NONE);
    });

  test("takes only the tables it draws from", () => {
    const drawn = Object.keys(tables).map((t) => `${file}#${t}.`);
    expect(
      MAILBOX.takes().filter((r) => !drawn.some((d) => r.startsWith(d))),
    ).toEqual([]);
  });

  test("shows every value it renders in one of its generated sections", () => {
    const text = sectionsOf(MAILBOX);
    expect(
      MAILBOX.values()
        .map((v) => String(v.name))
        .filter((n) => !text.includes(`| \`${n}\` |`)),
    ).toEqual([]);
  });
});

describe("the pull-request labels", () => {
  const file = "plugin/shared/pr-labels/projection.ts";

  test("render or explicitly leave out every state and every command", () => {
    expect(reach(PR_LABELS, file, "STATE_LABELS", PROJECTED_STATES)).toEqual(
      NONE,
    );
    expect(reach(PR_LABELS, file, "COMMAND_LABELS", COMMANDS)).toEqual(NONE);
  });

  test("are the label set the setup creates, with its descriptions as their meanings", () => {
    const set = labelSet({ ...DEFAULT_LABELS, enabled: true });
    const text = sectionsOf(PR_LABELS);
    for (const label of set) expect(text).toContain(`| \`${label.name}\` |`);
    expect(
      PR_LABELS.values().map((v) => ({
        name: `${DEFAULT_LABELS.prefix}${String(v.name)}`,
        meaning: v.meaning,
      })),
    ).toEqual(set.map((l) => ({ name: l.name, meaning: l.description })));
  });
});
