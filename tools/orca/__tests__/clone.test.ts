/**
 * Opening a repository Orca does not have yet, with a clone source: the
 * clone made and added to Orca once, under a claim, against the table in
 * table.ts.
 */
import { describe, expect, test } from "bun:test";
import { type Answer, fail, ok } from "../../herdr/__tests__/fake.ts";
import type { RunResult } from "../../herdr/runner.ts";
import {
  CLONE_TIMEOUT_MS,
  cloneCommand,
  cloneMissingRepo,
  HOME_SCRIPT,
  redactUrl,
} from "../clone.ts";
import { openArgs, openWorkspace, parseOpen } from "../workspace.ts";
import {
  absent,
  answer,
  create,
  fresh,
  inspect,
  isDir,
  onBox,
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
/** The clone of `url` into the clone's path, with its prompts off. */
const cloneOf = (url: string): string => cloneCommand(url, CLONE).join(" ");
const gitClone = cloneOf(URL);
const origin = `git -C ${CLONE} remote get-url origin`;
const prefix = `git -C ${CLONE} rev-parse --show-prefix`;
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
    for (const call of [takeClaim, gitClone, add, releaseClaim])
      expect(ws.ctx.calls).toContain(call);
    expect(at(takeClaim)).toBeLessThan(at(gitClone));
    expect(at(gitClone)).toBeLessThan(at(add));
    expect(at(add)).toBeLessThan(at(releaseClaim));
    expect(at(releaseClaim)).toBeLessThan(at(create("origin/main")));
  });

  test("whose clone is already at the path is added without cloning again", () => {
    const ws = workspaceOf(
      table([missing, missing, found], {
        [inspect(CLONE)]: isDir,
        [prefix]: ok("\n"),
        [origin]: ok(`${URL}\n`),
        [add]: answer({ repo: { id: RID, path: CLONE } }),
      }),
    );
    openWorkspace(ws, cloning);
    expect(ws.ctx.calls).not.toContain(gitClone);
    expect(ws.ctx.calls).toContain(add);
  });

  test("whose path is only a directory inside a clone of the source is not taken for its clone", () => {
    const ws = workspaceOf(
      table([missing, missing], {
        [inspect(CLONE)]: isDir,
        [prefix]: ok("app/\n"),
        [origin]: ok(`${URL}\n`),
      }),
    );
    expect(() => openWorkspace(ws, cloning)).toThrow(
      `${CLONE} is there but is not a clone of ${URL}`,
    );
    expect(ws.ctx.calls).not.toContain(add);
  });

  test("whose clone did not end on its own keeps the claim, for a clone that may still run", () => {
    const ws = workspaceOf(
      table([missing, missing], {
        [inspect(CLONE)]: absent,
        [gitClone]: fail(-1, "spawnSync ssh ETIMEDOUT"),
      }),
    );
    expect(() => openWorkspace(ws, cloning)).toThrow(
      `so the claim ${CLAIM} stays`,
    );
    expect(ws.ctx.calls).not.toContain(releaseClaim);
  });

  test("whose SSH session to the clone's machine was lost keeps the claim, for a clone that may still run", () => {
    const ws = workspaceOf(
      onBox(
        table([missing], {
          [inspect(CLONE)]: absent,
          [gitClone]: fail(255, "Connection to box closed by remote host."),
        }),
      ),
      "box",
      "box",
    );
    expect(() =>
      cloneMissingRepo(ws, "app", { url: URL, root: "~/dev" }),
    ).toThrow(`so the claim ${CLAIM} stays`);
    expect(ws.ctx.calls).not.toContain(releaseClaim);
  });

  test("whose clone on this machine exits 255 fails as any failed clone does", () => {
    const ws = workspaceOf(
      table([missing, missing], {
        [inspect(CLONE)]: absent,
        [gitClone]: fail(255, "fatal: something"),
      }),
    );
    expect(() => openWorkspace(ws, cloning)).toThrow("failed:");
    expect(ws.ctx.calls).toContain(releaseClaim);
  });

  test("from an absolute path with spaces is cloned", () => {
    const source = "/srv/Source Repositories/app";
    const ws = workspaceOf(
      table([missing, missing, found], {
        [inspect(CLONE)]: absent,
        [cloneOf(source)]: ok(),
        [add]: answer({ repo: { id: RID, path: CLONE } }),
      }),
    );
    openWorkspace(ws, { ...options, clone: { url: source, root: "~/dev" } });
    expect(ws.ctx.calls).toContain(cloneOf(source));
  });

  test("from an SSH source with an absolute path is cloned", () => {
    const source = "git@example.com:/srv/git/app.git";
    const ws = workspaceOf(
      table([missing, missing, found], {
        [inspect(CLONE)]: absent,
        [cloneOf(source)]: ok(),
        [add]: answer({ repo: { id: RID, path: CLONE } }),
      }),
    );
    openWorkspace(ws, { ...options, clone: { url: source, root: "~/dev" } });
    expect(ws.ctx.calls).toContain(cloneOf(source));
  });

  test("shows its source with the credentials hidden, in progress and failure alike", () => {
    const secret = "https://user:s3cret@example.com/acme/app.git";
    const ws = workspaceOf(
      table([missing, missing], {
        [inspect(CLONE)]: absent,
        [cloneOf(secret)]: fail(
          128,
          `fatal: unable to access '${secret}/': 403`,
        ),
      }),
    );
    let message = "";
    try {
      openWorkspace(ws, { ...options, clone: { url: secret, root: "~/dev" } });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("https://***@example.com/acme/app.git");
    expect(message).not.toContain("s3cret");
    expect(ws.ctx.lines.join("\n")).not.toContain("s3cret");
    expect(ws.ctx.lines.join("\n")).toContain("***@example.com");
  });

  test("whose source is not a URL, an SSH path or an absolute path is refused before git runs", () => {
    for (const url of [
      "ext::sh -c touch% /tmp/x",
      "--upload-pack=touch /tmp/x",
      "app",
      "file://example.com/x",
      "/srv/app\n--upload-pack=x",
    ]) {
      const ws = workspaceOf(table([missing], {}));
      expect(() =>
        openWorkspace(ws, { ...options, clone: { url, root: "~/dev" } }),
      ).toThrow("is not an https://, ssh:// or git:// URL");
      expect(ws.ctx.calls.some((call) => call.includes("git clone"))).toBe(
        false,
      );
    }
  });

  test("whose refused source carries credentials it cannot split shows none of them", () => {
    for (const url of [
      "https://user:pa@ss@example.com/app.git",
      "https://user:p/ss@example.com/app.git",
    ]) {
      const ws = workspaceOf(table([missing], {}));
      let message = "";
      try {
        openWorkspace(ws, { ...options, clone: { url, root: "~/dev" } });
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("the clone source https://*** is not");
      expect(message).not.toContain("user:p");
      expect(message).not.toContain("ss@");
    }
  });

  test("shows a taken source whose path holds an @ unchanged", () => {
    expect(redactUrl("https://example.com/acme/app@v2.git")).toBe(
      "https://example.com/acme/app@v2.git",
    );
    expect(redactUrl("https://u:s@example.com/acme/app@v2.git")).toBe(
      "https://***@example.com/acme/app@v2.git",
    );
  });

  test("is waited for no longer than the clone's limit, however slow each look is", () => {
    let clock = 0;
    const ws = workspaceOf(
      table([missing], {
        [takeClaim]: fail(
          1,
          `mkdir: cannot create directory '${CLAIM}': File exists\n`,
        ),
        [inspect(CLAIM)]: isDir,
      }),
    );
    expect(() =>
      cloneMissingRepo(
        ws,
        "app",
        { url: URL, root: "~/dev" },
        () => (clock += 90_000),
      ),
    ).toThrow("was still being cloned after 10 minutes");
    // Each look takes 90 s of the clock, so ten minutes hold only a few.
    const looks = ws.ctx.calls.filter((call) => call === show).length;
    expect(looks).toBeLessThanOrEqual(CLONE_TIMEOUT_MS / 90_000);
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
        [prefix]: ok("\n"),
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
