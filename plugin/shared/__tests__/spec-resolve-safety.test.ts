/**
 * What the spec resolver will not read or trust: a folder's files one by
 * one, code in the body, an adapter that hangs, and lists that share an id.
 */
import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import type { SpecAdapter } from "../spec/adapter.ts";
import { bodyAdapter } from "../spec/adapters/body.ts";
import { checkedFiles } from "../spec/files.ts";
import { checkPath } from "../spec/references.ts";
import { resolveSpec } from "../spec/resolve.ts";
import { issue, only, put, scratchRepo, stub } from "./spec-helpers.ts";

describe("a folder reference", () => {
  test.skipIf(
    skipsOnWindows(
      "file-system",
      "creating a symbolic link needs a privilege Windows withholds by default",
    ),
  )(
    "its files are checked one by one: an ignored file and a link out are not read",
    async () => {
      const { root, outside } = scratchRepo("spec-safety-");
      put(root, "notes/export/criteria.md", "AC-1 Has a header row\n");
      put(root, "notes/export/private.md", "AC-8 ignored\n");
      put(root, ".gitignore", "notes/export/private.md\n");
      put(outside, "secret.md", "AC-9 outside\n");
      symlinkSync(
        join(outside, "secret.md"),
        join(root, "notes", "export", "leak.md"),
      );
      const result = await resolveSpec(
        issue("## Spec\n\nnotes/export/\n"),
        root,
        { registry: [stub("notes", "notes")], config: only("notes") },
      );
      expect(result.acceptance.map((c) => c.key)).toEqual([
        "notes/export/#AC-1",
      ]);
      expect(result.unresolved).toEqual([
        "notes/export/leak.md (symbolic link out of the repository)",
        "notes/export/private.md (ignored by Git)",
      ]);
    },
  );

  test.skipIf(
    skipsOnWindows(
      "file-system",
      "creating a symbolic link needs a privilege Windows withholds by default",
    ),
  )(
    "a file is held to the folder by its real location, not the name it is asked for by",
    async () => {
      const { root } = scratchRepo("spec-safety-");
      put(root, "notes/export/criteria.md", "AC-1 x\n");
      put(root, "secrets.txt", "AC-9 a secret\n");
      symlinkSync(
        join(root, "secrets.txt"),
        join(root, "notes", "export", "leak.md"),
      );
      const checked = await checkPath("notes/export/", root);
      if (!checked.ok) throw new Error(checked.reason);
      const files = checkedFiles(checked, root);
      expect(await files.list()).toEqual(["notes/export/criteria.md"]);
      expect(files.refused).toEqual([
        "notes/export/leak.md (symbolic link out of notes/export/)",
      ]);
      await expect(
        files.read("notes/export/../../secrets.txt"),
      ).rejects.toThrow("or under it");
      await expect(
        files.read("notes/export/%2e%2e/%2e%2e/secrets.txt"),
      ).rejects.toThrow("not found");
      await expect(files.read("notes/export/../../../x")).rejects.toThrow(
        "leaves the repository",
      );
      await expect(files.read("notes/export/leak.md")).rejects.toThrow(
        "or under it",
      );
    },
  );

  test.skipIf(
    skipsOnWindows("file-system", "a named pipe is a POSIX file type"),
  )(
    "a pipe is refused rather than read, and a read stops on its signal",
    async () => {
      const { root } = scratchRepo("spec-safety-");
      put(root, "notes/export/criteria.md", "AC-1 x\n");
      const fifo = Bun.spawnSync(
        ["mkfifo", join(root, "notes", "export", "pipe.md")],
        { stdout: "pipe", stderr: "pipe" },
      );
      expectSpawnExit(fifo, 0, "mkfifo");
      expect(await checkPath("notes/export/pipe.md", root)).toEqual({
        ok: false,
        reason: "not a regular file",
      });
      const checked = await checkPath("notes/export/", root);
      if (!checked.ok) throw new Error(checked.reason);
      const files = checkedFiles(checked, root);
      expect(await files.list()).toEqual(["notes/export/criteria.md"]);
      expect(files.refused).toEqual([
        "notes/export/pipe.md (not a regular file)",
      ]);
      await expect(
        files.read("notes/export/criteria.md", AbortSignal.abort()),
      ).rejects.toThrow();
    },
  );

  test("its reader refuses a file outside it, and one that fails the checks", async () => {
    const { root } = scratchRepo("spec-safety-");
    put(root, "notes/export/criteria.md", "AC-1 x\n");
    put(root, "notes/other.md", "AC-2 y\n");
    put(root, "notes/export/private.md", "AC-3 z\n");
    put(root, ".gitignore", "notes/export/private.md\n");
    const checked = await checkPath("notes/export", root);
    if (!checked.ok) throw new Error(checked.reason);
    const files = checkedFiles(checked, root);
    expect(await files.list()).toEqual(["notes/export/criteria.md"]);
    expect(await files.read("notes/export/criteria.md")).toBe("AC-1 x\n");
    await expect(files.read("notes/other.md")).rejects.toThrow("or under it");
    await expect(files.read("notes/export/../other.md")).rejects.toThrow(
      "or under it",
    );
    await expect(files.read("notes/export/private.md")).rejects.toThrow(
      "ignored by Git",
    );
    await expect(
      files.read("notes/export/criteria.md", AbortSignal.abort()),
    ).rejects.toThrow();
  });

  test("its files are names as written: a # or % in one is part of it, never an anchor or an escape", async () => {
    const { root } = scratchRepo("spec-safety-");
    put(root, "notes/export/criteria#1.md", "AC-1 x\n");
    put(root, "notes/export/criteria", "AC-8 the wrong file\n");
    put(root, "notes/export/100%25.md", "AC-2 y\n");
    put(root, "notes/export/100%.md", "AC-9 the wrong file\n");
    const checked = await checkPath("notes/export/", root);
    if (!checked.ok) throw new Error(checked.reason);
    const files = checkedFiles(checked, root);
    const listed = await files.list();
    expect(listed).toEqual([
      "notes/export/100%.md",
      "notes/export/100%25.md",
      "notes/export/criteria",
      "notes/export/criteria#1.md",
    ]);
    expect(await files.read("notes/export/criteria#1.md")).toBe("AC-1 x\n");
    expect(await files.read("notes/export/100%25.md")).toBe("AC-2 y\n");
    expect(files.refused).toEqual([]);
  });

  test.skipIf(
    skipsOnWindows(
      "file-system",
      "creating a symbolic link needs a privilege Windows withholds by default",
    ),
  )("a file reached by two names is listed once", async () => {
    const { root } = scratchRepo("spec-safety-");
    put(root, "notes/export/criteria.md", "AC-1 x\n");
    symlinkSync("criteria.md", join(root, "notes", "export", "alias.md"));
    const result = await resolveSpec(
      issue("## Spec\n\nnotes/export/\n"),
      root,
      { registry: [stub("notes", "notes")], config: only("notes") },
    );
    expect(result.unresolved).toEqual([]);
    expect(result.acceptance.map((c) => c.key)).toEqual(["notes/export/#AC-1"]);
  });
});

test("a path whose first segment only starts with .. is inside the root", async () => {
  const { root } = scratchRepo("spec-safety-");
  put(root, "..notes/a.md", "AC-1 x\n");
  const result = await resolveSpec(issue("## Spec\n\n- ..notes/a.md\n"), root, {
    registry: [stub("dots", "..notes")],
    config: only("dots"),
  });
  expect(result.unresolved).toEqual([]);
  expect(result.acceptance.map((c) => c.key)).toEqual(["..notes/a.md#AC-1"]);
});

test("code is never content: a longer fence holds a shorter one, and indented code holds no entry or reference", async () => {
  const { root } = scratchRepo("spec-safety-");
  const body = [
    "## Spec",
    "",
    "````md",
    "```",
    "## Acceptance criteria",
    "",
    "- AC-9 Example",
    "````",
    "",
    "    - [ ] 1. Example task",
    "    notes/example.md",
    "",
    "- [ ] 2. Real task",
    "",
    "    - [ ] 2.1 Its nested step",
  ].join("\n");
  const result = await resolveSpec(issue(body), root, {
    registry: [bodyAdapter],
    config: only("body"),
  });
  expect(result.sources.map((s) => s.ref)).toEqual(["#body/Spec"]);
  expect(result.acceptance).toEqual([]);
  expect(result.tasks.map((t) => t.id)).toEqual(["2", "2.1"]);
  expect(result.unresolved).toEqual([]);
});

test("a fence indented under a list item is the item's code, not its content", async () => {
  const { root } = scratchRepo("spec-safety-");
  const body = [
    "## Spec",
    "",
    "- [ ] 1. Real task",
    "",
    "    ```md",
    "    - AC-9 Example",
    "    notes/example.md",
    "    ```",
    "",
    "- [ ] 2. Next task",
  ].join("\n");
  const result = await resolveSpec(issue(body), root, {
    registry: [bodyAdapter],
    config: only("body"),
  });
  expect(result.acceptance).toEqual([]);
  expect(result.tasks.map((t) => t.id)).toEqual(["1", "2"]);
  expect(result.unresolved).toEqual([]);
});

test("a fence that opens on a list item's own line is the item's code", async () => {
  const { root } = scratchRepo("spec-safety-");
  for (const fence of ["```", "~~~"]) {
    const body = [
      "## Spec",
      "",
      `- ${fence}md`,
      "  AC-9 Example",
      `  ${fence}`,
      "- [ ] 1. Real task",
    ].join("\n");
    const result = await resolveSpec(issue(body), root, {
      registry: [bodyAdapter],
      config: only("body"),
    });
    expect(result.acceptance).toEqual([]);
    expect(result.tasks.map((t) => t.id)).toEqual(["1"]);
  }
});

test("text four columns past a list marker's content column is the item's indented code", async () => {
  const { root } = scratchRepo("spec-safety-");
  for (const marker of ["-", "1."]) {
    const body = [
      "## Spec",
      "",
      `${marker}     AC-9 Example`,
      `${" ".repeat(marker.length + 5)}AC-8 Its next line`,
      "- [ ] 1. Real task",
    ].join("\n");
    const result = await resolveSpec(issue(body), root, {
      registry: [bodyAdapter],
      config: only("body"),
    });
    expect(result.acceptance).toEqual([]);
    expect(result.tasks.map((t) => t.id)).toEqual(["1"]);
  }
});

test("a fence opened in a list item ends with the item", async () => {
  const { root } = scratchRepo("spec-safety-");
  const body = [
    "## Spec",
    "",
    "- ```md",
    "  AC-9 Example",
    "",
    "## Acceptance criteria",
    "- AC-1 Works",
  ].join("\n");
  const result = await resolveSpec(issue(body), root, {
    registry: [bodyAdapter],
    config: only("body"),
  });
  expect(result.acceptance.map((c) => c.id)).toEqual(["AC-1"]);
});

test("a line that ends a nested item leaves its enclosing item open", async () => {
  const { root } = scratchRepo("spec-safety-");
  for (const inner of [["  - ~~~md", "    example"], ["  - Inner note"]]) {
    const body = [
      "## Spec",
      "- [ ] 1. Outer task",
      ...inner,
      "",
      "  Outer explanation",
      "",
      "    - [ ] 2. Nested task",
    ].join("\n");
    const result = await resolveSpec(issue(body), root, {
      registry: [bodyAdapter],
      config: only("body"),
    });
    expect(result.tasks.map((t) => t.id)).toEqual(["1", "2"]);
  }
});

test("text that starts with # but is no heading leaves the open items open", async () => {
  const { root } = scratchRepo("spec-safety-");
  for (const note of ["  #58 tracks this", "#58 tracks this", "  #tag"]) {
    const body = [
      "## Spec",
      "- [ ] 1. Outer task",
      note,
      "",
      "    - [ ] 2. Nested task",
    ].join("\n");
    const result = await resolveSpec(issue(body), root, {
      registry: [bodyAdapter],
      config: only("body"),
    });
    expect(result.tasks.map((t) => t.id)).toEqual(["1", "2"]);
  }
});

test("a heading inside a list item leaves the item and its section open", async () => {
  const { root } = scratchRepo("spec-safety-");
  const cases = ["###", "##", "#"].flatMap((run) => [
    { run, notes: ["", `    ${run} Notes`, ""] },
    { run, notes: [`  ${run} Notes`] },
    { run, notes: [`  ${run} Notes`, ""] },
  ]);
  for (const { run, notes } of cases) {
    const body = [
      "## Spec",
      "- [ ] 1. Outer task",
      ...notes,
      "    - [ ] 2. Nested task",
      "",
      "## Acceptance criteria",
      "- AC-1 Works",
      "",
      `  ${run} Details`,
      "",
      "  - AC-2 Nested criterion",
    ].join("\n");
    const result = await resolveSpec(issue(body), root, {
      registry: [bodyAdapter],
      config: only("body"),
    });
    expect(result.tasks.map((t) => t.id)).toEqual(["1", "2"]);
    expect(result.acceptance.map((c) => c.id)).toEqual(["AC-1", "AC-2"]);
  }
});

test("a block quote or a thematic break before a list item's column ends the item", async () => {
  const { root } = scratchRepo("spec-safety-");
  for (const block of ["> Quote", "---", "* * *", "___"]) {
    const body = [
      "## Spec",
      "- [ ] 1. Real task",
      block,
      "  ### Notes",
      "",
      "    - [ ] 2. Example in indented code",
    ].join("\n");
    const result = await resolveSpec(issue(body), root, {
      registry: [bodyAdapter],
      config: only("body"),
    });
    expect(result.tasks.map((t) => t.id)).toEqual(["1"]);
  }
});

test("a block quote or a thematic break after an entry is no part of it and no entry", async () => {
  const { root } = scratchRepo("spec-safety-");
  const plain = await resolveSpec(
    issue(["## Acceptance criteria", "- Works"].join("\n")),
    root,
    { registry: [bodyAdapter], config: only("body") },
  );
  for (const block of ["* * *", "---", "___", "> Quote", "> FR-9 quoted"]) {
    const body = ["## Acceptance criteria", "- Works", block].join("\n");
    const result = await resolveSpec(issue(body), root, {
      registry: [bodyAdapter],
      config: only("body"),
    });
    expect(result.acceptance.map((c) => [c.id, c.text])).toEqual(
      plain.acceptance.map((c) => [c.id, c.text]),
    );
    expect(result.acceptance.map((c) => c.text)).toEqual(["Works"]);
  }
});

test("a block quote inside a list item still continues it", async () => {
  const { root } = scratchRepo("spec-safety-");
  const body = ["## Acceptance criteria", "- Works", "  > as quoted"].join(
    "\n",
  );
  const result = await resolveSpec(issue(body), root, {
    registry: [bodyAdapter],
    config: only("body"),
  });
  expect(result.acceptance.map((c) => c.text)).toEqual(["Works > as quoted"]);
});

test("a list item after a block that ends the list is an entry of its own", async () => {
  const { root } = scratchRepo("spec-safety-");
  const nested = await resolveSpec(
    issue(["## Acceptance criteria", "- Works", "  - in detail"].join("\n")),
    root,
    { registry: [bodyAdapter], config: only("body") },
  );
  expect(nested.acceptance.map((c) => c.text)).toEqual(["Works in detail"]);
  for (const block of [
    ["---"],
    ["* * *"],
    ["```", "x", "```"],
    ["### Notes"],
  ]) {
    const body = [
      "## Acceptance criteria",
      "- Works",
      ...block,
      "  - Separate criterion",
    ].join("\n");
    const result = await resolveSpec(issue(body), root, {
      registry: [bodyAdapter],
      config: only("body"),
    });
    expect(result.acceptance.map((c) => c.text)).toEqual([
      "Works",
      "Separate criterion",
    ]);
  }
});

test("a line that lazily continues a block quote's paragraph is quoted, not an entry", async () => {
  const { root } = scratchRepo("spec-safety-");
  const read = async (lines: string[]) =>
    resolveSpec(issue(lines.join("\n")), root, {
      registry: [bodyAdapter],
      config: only("body"),
    });
  const lazy = await read([
    "## Spec",
    "> Example only:",
    "AC-9 Example criterion",
  ]);
  expect(lazy.acceptance).toEqual([]);
  const joined = await read([
    "## Acceptance criteria",
    "- Works",
    "> Example only:",
    "an example line",
  ]);
  expect(joined.acceptance.map((c) => c.text)).toEqual(["Works"]);
  const after = await read([
    "## Spec",
    "> Example only:",
    "",
    "AC-9 Real criterion",
  ]);
  expect(after.acceptance.map((c) => c.id)).toEqual(["AC-9"]);
  for (const marker of ["2.", "3)"]) {
    const ordered = await read([
      "## Spec",
      "> Example only:",
      `${marker} AC-9 Example criterion`,
    ]);
    expect(ordered.acceptance).toEqual([]);
  }
  const indented = await read([
    "## Spec",
    "> Example only:",
    "    AC-9 Example criterion",
  ]);
  expect(indented.acceptance).toEqual([]);
});

test("only a quoted paragraph is continued lazily: a line after quoted code, a heading or a break is read", async () => {
  const { root } = scratchRepo("spec-safety-");
  for (const quoted of [
    ["> # Note"],
    ["> ---"],
    ["> ```"],
    ["> ```", "> AC-8 in quoted code"],
    [">     quoted indented code"],
    ["> - "],
    ["> Text", "> ***"],
  ]) {
    const body = ["## Spec", ...quoted, "AC-1 Works"].join("\n");
    const result = await resolveSpec(issue(body), root, {
      registry: [bodyAdapter],
      config: only("body"),
    });
    expect(result.acceptance.map((c) => c.id)).toEqual(["AC-1"]);
  }
  for (const quoted of [
    ["> - quoted item"],
    ["> Text", ">     still the paragraph"],
    ["> ```", "> code", "> ```", "> Text"],
  ]) {
    const body = ["## Spec", ...quoted, "AC-1 Example"].join("\n");
    const result = await resolveSpec(issue(body), root, {
      registry: [bodyAdapter],
      config: only("body"),
    });
    expect(result.acceptance).toEqual([]);
  }
});

test("a fence before a list item's column ends the item", async () => {
  const { root } = scratchRepo("spec-safety-");
  for (const gap of [[""], []]) {
    const body = [
      "## Spec",
      "- [ ] 1. Real task",
      ...gap,
      "```md",
      "x",
      "```",
      "",
      "    - [ ] 2. Example in indented code",
    ].join("\n");
    const result = await resolveSpec(issue(body), root, {
      registry: [bodyAdapter],
      config: only("body"),
    });
    expect(result.tasks.map((t) => t.id)).toEqual(["1"]);
  }
});

test("a line of list markers past the nesting bound is read without running the scan deep", async () => {
  const { root } = scratchRepo("spec-safety-");
  const body = [
    "## Spec",
    "",
    `${"- ".repeat(200_000)}x`,
    "",
    "## Acceptance criteria",
    "- AC-1 Works",
  ].join("\n");
  const result = await resolveSpec(issue(body), root, {
    registry: [bodyAdapter],
    config: only("body"),
  });
  expect(result.acceptance.map((c) => c.id)).toEqual(["AC-1"]);
});

test("a heading inside a section ends the entry above it", async () => {
  const { root } = scratchRepo("spec-safety-");
  const body = [
    "## Acceptance criteria",
    "- Works",
    "### Notes",
    "Extra explanation",
    "## Other",
    "## Acceptance criteria",
    "Also explained",
  ].join("\n");
  const result = await resolveSpec(issue(body), root, {
    registry: [bodyAdapter],
    config: only("body"),
  });
  expect(result.acceptance.map((c) => c.text)).toEqual(["Works"]);
});

test("a section keeps the code its context made: a heading that closed a list still closes it", async () => {
  const { root } = scratchRepo("spec-safety-");
  const body = [
    "## Spec",
    "",
    "- [ ] 1. Real task",
    "",
    "### Example",
    "",
    "    - AC-9 Example",
    "    notes/example.md",
  ].join("\n");
  const result = await resolveSpec(issue(body), root, {
    registry: [bodyAdapter],
    config: only("body"),
  });
  expect(result.acceptance).toEqual([]);
  expect(result.tasks.map((t) => t.id)).toEqual(["1"]);
  expect(result.unresolved).toEqual([]);
});

test("detect failures are reported in the configured order, whichever fails first", async () => {
  const { root } = scratchRepo("spec-safety-");
  const failing = (name: string, ms: number): SpecAdapter => ({
    ...stub(name, name),
    detect: () =>
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("broken")), ms),
      ),
  });
  const result = await resolveSpec(issue(""), root, {
    registry: [failing("late", 40), failing("early", 1)],
    config: only("late", "early"),
  });
  expect(result.unresolved).toEqual([
    "late adapter (could not tell whether its layout is present: broken)",
    "early adapter (could not tell whether its layout is present: broken)",
  ]);
});

test("an adapter that does not answer by the deadline is given up on, its signal aborted", async () => {
  const { root } = scratchRepo("spec-safety-");
  put(root, "notes/a.md", "AC-1 x\n");
  const aborted: string[] = [];
  const hang = (what: string, signal: AbortSignal) =>
    new Promise<never>(() => {
      signal.addEventListener("abort", () => aborted.push(what));
    });
  const slowDetect: SpecAdapter = {
    ...stub("slow", "slow"),
    detect: (_root, signal) => hang("detect", signal),
  };
  const slowRead: SpecAdapter = {
    ...stub("notes", "notes"),
    read: (_ref, signal) => hang("read", signal),
  };
  const result = await resolveSpec(issue("## Spec\n\n- notes/a.md\n"), root, {
    registry: [slowDetect, slowRead],
    config: only("slow", "notes"),
    deadlineMs: 50,
  });
  expect(result.sources).toEqual([]);
  expect(result.unresolved).toEqual([
    "slow adapter (could not tell whether its layout is present: no answer within 0.05 seconds)",
    "notes/a.md (notes could not read it: no answer within 0.05 seconds)",
  ]);
  expect(aborted.sort()).toEqual(["detect", "read"]);
});

test("a source whose lists share an id is refused, since both would get one key", async () => {
  const { root } = scratchRepo("spec-safety-");
  put(root, "notes/a.md", "x\n");
  const twice: SpecAdapter = {
    ...stub("notes", "notes"),
    read: () =>
      Promise.resolve({
        requirements: [{ id: "X-1", text: "a requirement" }],
        acceptance: [{ id: "X-1", text: "a criterion", requirement: null }],
        tasks: [],
      }),
  };
  const result = await resolveSpec(issue("## Spec\n\n- notes/a.md\n"), root, {
    registry: [twice],
    config: only("notes"),
  });
  expect(result.sources).toEqual([]);
  expect(result.unresolved).toEqual([
    "notes/a.md (notes gave the id X-1 to more than one entry)",
  ]);
});
