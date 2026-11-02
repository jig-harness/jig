import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitError } from "../../../shared/cli.ts";
import { orcaAnswering } from "../../../../lib/test-helpers/orca-answering.ts";
import {
  DEFAULT_STATUSES,
  DEFAULT_TEMPLATE,
  type NameRequest,
  nameConfig,
  parseArgs,
  renameWorkspace,
  renderName,
} from "../scripts/workspace-name.ts";

const ORCA = { ORCA_CLI_COMMAND: "/opt/orca/bin/orca" };
const ID = "repo-1::/ws/app/feat-x";
const request: NameRequest = {
  stage: "driving",
  id: "JIG-12",
  title: "Rename workspaces",
  pr: "42",
};
const config = (template: string | null) => ({
  template,
  statuses: { ...DEFAULT_STATUSES },
});

const ok = JSON.stringify({ ok: true, result: { worktree: { id: ID } } });
const renameKey = (name: string) =>
  `worktree set --worktree id:${ID} --display-name ${name} --json`;

describe("renderName", () => {
  test("fills every variable and the default status text", () => {
    expect(
      renderName("{status} {id} {title} {pr}", request, DEFAULT_STATUSES),
    ).toBe("[D] JIG-12 Rename workspaces #42");
  });

  test("an empty variable leaves no gap", () => {
    expect(
      renderName(
        "{status} {id} {pr}",
        { ...request, pr: "" },
        DEFAULT_STATUSES,
      ),
    ).toBe("[D] JIG-12");
  });

  test("each stage has its status text", () => {
    const texts = (["implementing", "driving", "ready", "done"] as const).map(
      (stage) =>
        renderName("{status}", { ...request, stage }, DEFAULT_STATUSES),
    );
    expect(texts).toEqual(["[I]", "[D]", "[R]", "✅"]);
  });

  test("an unknown variable is refused", () => {
    expect(() => renderName("{branch}", request, DEFAULT_STATUSES)).toThrow(
      ExitError,
    );
  });
});

describe("nameConfig", () => {
  test("absent means the default template, with the default statuses", () => {
    expect(nameConfig({})).toEqual(config(DEFAULT_TEMPLATE));
    expect(nameConfig({ workspace_name: {} }).template).toBe(DEFAULT_TEMPLATE);
  });

  test("an empty template turns it off; a blank one is refused", () => {
    expect(
      nameConfig({ workspace_name: { template: "" } }).template,
    ).toBeNull();
    expect(() => nameConfig({ workspace_name: { template: "  " } })).toThrow(
      ExitError,
    );
  });

  test("the default template names item, status and title", () => {
    expect(
      renderName(
        DEFAULT_TEMPLATE,
        { stage: "implementing", id: "#348", title: "Rename it", pr: "" },
        DEFAULT_STATUSES,
      ),
    ).toBe("#348 [I] Rename it");
  });

  test("the default template ends with the pull request once there is one", () => {
    expect(
      renderName(
        DEFAULT_TEMPLATE,
        { stage: "driving", id: "#348", title: "Rename it", pr: "359" },
        DEFAULT_STATUSES,
      ),
    ).toBe("#348 [D] Rename it #359");
  });

  test("a status entry overrides one stage and keeps the rest", () => {
    const read = nameConfig({
      workspace_name: { template: "{id}", statuses: { ready: "READY" } },
    });
    expect(read.statuses).toEqual({ ...DEFAULT_STATUSES, ready: "READY" });
    expect(read.template).toBe("{id}");
  });

  test("a stage outside the four is refused", () => {
    expect(() =>
      nameConfig({ workspace_name: { statuses: { merged: "M" } } }),
    ).toThrow(ExitError);
  });

  test("an empty or whitespace-only status is refused", () => {
    for (const text of ["", "   "])
      expect(() =>
        nameConfig({ workspace_name: { statuses: { ready: text } } }),
      ).toThrow(ExitError);
  });

  test("a key the section does not declare is refused", () => {
    expect(() => nameConfig({ workspace_name: { templtae: "{id}" } })).toThrow(
      ExitError,
    );
  });

  test("a template with unbalanced or nested braces is refused", () => {
    for (const template of ["{id", "id}", "{{id}}", "{id}}"])
      expect(() => nameConfig({ workspace_name: { template } })).toThrow(
        ExitError,
      );
    expect(
      nameConfig({ workspace_name: { template: "{id} {pr}" } }).template,
    ).toBe("{id} {pr}");
  });
});

describe("parseArgs", () => {
  test("reads the stage and flags", () => {
    expect(
      parseArgs(["ready", "--id", "JIG-1", "--title", "T", "--pr", "7"]),
    ).toEqual({ stage: "ready", id: "JIG-1", title: "T", pr: "7" });
  });

  test("takes no id for a pull request that serves no item", () => {
    expect(parseArgs(["ready", "--pr", "7"])).toEqual({
      stage: "ready",
      id: "",
      title: "",
      pr: "7",
    });
  });

  test("reads the title from a file as literal text", () => {
    const dir = mkdtempSync(join(tmpdir(), "workspace-name-"));
    try {
      const path = join(dir, "title.md");
      writeFileSync(path, 'Fix $(touch x) `id` "quoted"\n');
      expect(
        parseArgs(["driving", "--id", "#12", "--title-file", path]),
      ).toEqual({
        stage: "driving",
        id: "#12",
        title: 'Fix $(touch x) `id` "quoted"\n',
        pr: "",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a bad stage, a non-numeric pr, two titles and an unreadable title file", () => {
    expect(() => parseArgs(["merged", "--id", "A"])).toThrow(ExitError);
    expect(() => parseArgs(["ready", "--id", "A", "--pr", "x"])).toThrow(
      ExitError,
    );
    expect(() =>
      parseArgs(["ready", "--title", "A", "--title-file", "/nonexistent"]),
    ).toThrow(ExitError);
    expect(() =>
      parseArgs(["ready", "--title-file", "/nonexistent/title.md"]),
    ).toThrow(ExitError);
  });
});

describe("renameWorkspace", () => {
  test("makes no call with the template turned off", async () => {
    const { calls, runner } = orcaAnswering({});
    expect(
      await renameWorkspace(request, config(null), ORCA, runner),
    ).toContain("nothing to do");
    expect(calls).toEqual([]);
  });

  test("makes no call outside Orca", async () => {
    const { calls, runner } = orcaAnswering({});
    expect(await renameWorkspace(request, config("{id}"), {}, runner)).toBe(
      "workspace-name: not in Orca; nothing to do",
    );
    expect(calls).toEqual([]);
  });

  test("renames the current worktree", async () => {
    const { calls, runner } = orcaAnswering({
      "worktree current --json": ok,
      [renameKey("[D] JIG-12 Rename workspaces")]: ok,
    });
    expect(
      await renameWorkspace(
        request,
        config("{status} {id} {title}"),
        ORCA,
        runner,
      ),
    ).toBe("workspace-name: [D] JIG-12 Rename workspaces");
    expect(calls).toHaveLength(2);
  });

  test("a failed rename warns and does not throw", async () => {
    const { runner } = orcaAnswering({
      "worktree current --json": ok,
      [renameKey("JIG-12")]: JSON.stringify({ ok: false }),
    });
    expect(
      await renameWorkspace(request, config("{id}"), ORCA, runner),
    ).toContain("⚠ could not rename the workspace");
  });
});
