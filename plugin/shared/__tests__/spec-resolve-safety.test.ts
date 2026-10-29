/**
 * What the spec resolver will not read or trust: a folder's files one by
 * one, code in the body, an adapter that hangs, and lists that share an id.
 */
import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
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
    },
  );

  test("its reader refuses a file outside it, and one that fails the checks", async () => {
    const { root } = scratchRepo("spec-safety-");
    put(root, "notes/export/criteria.md", "AC-1 x\n");
    put(root, "notes/other.md", "AC-2 y\n");
    put(root, "notes/export/private.md", "AC-3 z\n");
    put(root, ".gitignore", "notes/export/private.md\n");
    const checked = checkPath("notes/export", root);
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
