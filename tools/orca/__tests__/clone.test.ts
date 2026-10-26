/**
 * Opening a repository Orca does not have yet, with a clone source: the
 * clone made and added to Orca once, under a claim, against the table in
 * table.ts.
 */
import { describe, expect, test } from "bun:test";
import { type Answer, fail, ok } from "../../herdr/__tests__/fake.ts";
import type { RunResult } from "../../herdr/runner.ts";
import { HOME_SCRIPT } from "../clone.ts";
import { openArgs, openWorkspace, parseOpen } from "../workspace.ts";
import {
  absent,
  answer,
  create,
  fresh,
  inspect,
  isDir,
  options,
  orcaError,
  R,
  RID,
  show,
  workspaceOf,
} from "./table.ts";

const URL = "git@example.com:acme/app.git";
const ROOT = "/home/me/dev";
const CLONE = `${ROOT}/app`;
const CLAIM = `${ROOT}/.app.jig-orca-clone`;
const cloning = { ...options, clone: { url: URL, root: "~/dev" } };

const missing = orcaError("repo_not_found");
const found = answer({ repo: { id: RID, path: R } });
const home = `sh -c ${HOME_SCRIPT}`;
const makeRoot = `mkdir -p ${ROOT}`;
const takeClaim = `mkdir ${CLAIM}`;
const releaseClaim = `rm -rf ${CLAIM}`;
const gitClone = `git clone -- ${URL} ${CLONE}`;
const origin = `git -C ${CLONE} remote get-url origin`;
const add = `orca repo add --path ${CLONE} --json`;

/** A fresh branch of a repository Orca has only once `show` has answered `answers` in turn. */
const table = (
  answers: RunResult[],
  extra: Record<string, Answer>,
): Record<string, Answer> => ({
  ...fresh,
  [show]: answers,
  [home]: ok("/home/me"),
  [makeRoot]: ok(),
  [takeClaim]: ok(),
  [releaseClaim]: ok(),
  ...extra,
});

describe("a repository Orca does not have", () => {
  test("is cloned under the root, added to Orca and opened, under a claim given back", () => {
    const ws = workspaceOf(
      table([missing, missing, found], {
        [inspect(CLONE)]: absent,
        [gitClone]: ok(),
        [add]: answer({ repo: { id: RID, path: CLONE } }),
      }),
    );
    openWorkspace(ws, cloning);
    const at = (call: string) => ws.ctx.calls.indexOf(call);
    expect(at(takeClaim)).toBeLessThan(at(gitClone));
    expect(at(gitClone)).toBeLessThan(at(add));
    expect(at(add)).toBeLessThan(at(releaseClaim));
    expect(at(releaseClaim)).toBeLessThan(at(create("origin/main")));
  });

  test("whose clone is already at the path is added without cloning again", () => {
    const ws = workspaceOf(
      table([missing, missing, found], {
        [inspect(CLONE)]: isDir,
        [origin]: ok(`${URL}\n`),
        [add]: answer({ repo: { id: RID, path: CLONE } }),
      }),
    );
    openWorkspace(ws, cloning);
    expect(ws.ctx.calls).not.toContain(gitClone);
    expect(ws.ctx.calls).toContain(add);
  });

  test("is not cloned when another open added it before this one took the claim", () => {
    const ws = workspaceOf(table([missing, found], {}));
    openWorkspace(ws, cloning);
    expect(ws.ctx.calls).not.toContain(gitClone);
    expect(ws.ctx.calls).toContain(releaseClaim);
  });

  test("whose path holds another repository stops the open and gives the claim back", () => {
    const ws = workspaceOf(
      table([missing, missing], {
        [inspect(CLONE)]: isDir,
        [origin]: ok("git@example.com:other/app.git\n"),
      }),
    );
    expect(() => openWorkspace(ws, cloning)).toThrow(
      `${CLONE} is there but is not a clone of ${URL}`,
    );
    expect(ws.ctx.calls).toContain(releaseClaim);
    expect(ws.ctx.calls).not.toContain(add);
  });

  test("whose clone fails stops the open, saying what the machine needs", () => {
    const ws = workspaceOf(
      table([missing, missing], {
        [inspect(CLONE)]: absent,
        [gitClone]: fail(128, "Permission denied (publickey)"),
      }),
    );
    expect(() => openWorkspace(ws, cloning)).toThrow(
      "without a prompt (an SSH key, a credential helper)",
    );
    expect(ws.ctx.calls).toContain(releaseClaim);
  });

  test("that another open is cloning is waited for, and not cloned again", () => {
    const ws = workspaceOf(
      table([missing, missing, found], {
        [takeClaim]: fail(
          1,
          `mkdir: cannot create directory '${CLAIM}': File exists\n`,
        ),
        [inspect(CLAIM)]: isDir,
      }),
    );
    openWorkspace(ws, cloning);
    expect(ws.ctx.calls).not.toContain(gitClone);
    expect(ws.ctx.calls).not.toContain(releaseClaim);
  });

  test("whose cloning open ended without adding it stops the waiting open", () => {
    const ws = workspaceOf(
      table([missing], {
        [takeClaim]: fail(
          1,
          `mkdir: cannot create directory '${CLAIM}': File exists\n`,
        ),
        [inspect(CLAIM)]: absent,
      }),
    );
    expect(() => openWorkspace(ws, cloning)).toThrow(
      "ended without adding it to Orca",
    );
  });

  test("without a clone source is named, as before", () => {
    const ws = workspaceOf({ ...fresh, [show]: missing });
    expect(() => openWorkspace(ws, options)).toThrow(
      "Orca has no repository named app",
    );
  });
});

describe("the clone's command line", () => {
  test("reads back what the launcher hands it", () => {
    const parsed = parseOpen(openArgs(cloning));
    expect(parsed.clone).toEqual(cloning.clone);
  });

  test("needs a URL and a root together", () => {
    expect(() =>
      parseOpen(["--repo", "app", "--branch", "x", "--clone-url", URL]),
    ).toThrow("--clone-url and --clone-root go together");
  });

  test("refuses a root that is neither absolute nor under ~/", () => {
    const ws = workspaceOf(table([missing], {}));
    expect(() =>
      openWorkspace(ws, { ...options, clone: { url: URL, root: "dev" } }),
    ).toThrow("must be an absolute path or start with ~/");
  });
});
