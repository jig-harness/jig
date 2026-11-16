/**
 * The drive's own `.context/` files never make the tree read as unclean: where
 * the repository does not ignore `.context/`, the drive adds it to the clone's
 * local exclude file once, and a repository that ignores it is left as it is.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  CONTEXT_PATTERN,
  type ContextIgnore,
} from "../scripts/lib/context-ignore.ts";
import { type Clone, makeClone } from "./attach-pr-fixtures.ts";

const MODULE = join(
  import.meta.dir,
  "..",
  "scripts",
  "lib",
  "context-ignore.ts",
);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * Git's settings with no user's ignore rules in them: a person's global
 * `core.excludesFile` or `~/.config/git/ignore` may well ignore `.context/`.
 */
const isolated = (() => {
  const home = realpathSync(
    mkdtempSync(join(tmpdir(), "context-ignore-home-")),
  );
  roots.push(home);
  const config = join(home, "gitconfig");
  writeFileSync(config, "");
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
  };
})();

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  return { ...env, ...isolated };
}

/** `ensureContextIgnored(tree)`, run in a child under the isolated settings. */
function ensureContextIgnored(tree: string): ContextIgnore {
  const script = `const { ensureContextIgnored } = await import(${JSON.stringify(MODULE)});
console.log(JSON.stringify(await ensureContextIgnored(process.argv[1])));`;
  const r = Bun.spawnSync([process.execPath, "-e", script, tree], {
    env: gitEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const ran = {
    exitCode: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
  expectSpawnExit(ran, 0, "ensureContextIgnored");
  return JSON.parse(ran.stdout) as ContextIgnore;
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: gitEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(
    {
      exitCode: r.exitCode,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    },
    0,
    `git ${args.join(" ")}`,
  );
  return r.stdout.toString().trim();
}

/** A fresh repository whose ignore rules say nothing of `.context/`. */
function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "context-ignore-")));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  return root;
}

function excludeOf(tree: string): string {
  return readFileSync(join(tree, ".git", "info", "exclude"), "utf8");
}

function contextLines(text: string): number {
  return text.split("\n").filter((line) => line.trim() === CONTEXT_PATTERN)
    .length;
}

function untracked(tree: string): string {
  return git(tree, "status", "--porcelain", "--untracked-files=normal");
}

describe("ensureContextIgnored", () => {
  test("adds .context/ to the exclude file, once, keeping its lines", () => {
    const tree = repo();
    writeFileSync(join(tree, ".git", "info", "exclude"), "# local\n*.swp");
    const first = ensureContextIgnored(tree);
    expect(first.kind).toBe("excluded");
    const second = ensureContextIgnored(tree);
    expect(second.kind).toBe("ignored");
    expect(excludeOf(tree)).toBe(`# local\n*.swp\n${CONTEXT_PATTERN}\n`);
  });

  test("creates the exclude file when the clone has none", () => {
    const tree = repo();
    rmSync(join(tree, ".git", "info"), { recursive: true, force: true });
    expect(ensureContextIgnored(tree).kind).toBe("excluded");
    expect(excludeOf(tree)).toBe(`${CONTEXT_PATTERN}\n`);
  });

  test("leaves a repository whose .gitignore covers .context/ alone", () => {
    const tree = repo();
    writeFileSync(join(tree, ".gitignore"), ".context\n");
    const before = excludeOf(tree);
    expect(ensureContextIgnored(tree).kind).toBe("ignored");
    expect(excludeOf(tree)).toBe(before);
    expect(contextLines(excludeOf(tree))).toBe(0);
  });

  test("writes the clone's exclude file from a linked working tree", () => {
    const tree = repo();
    writeFileSync(join(tree, "seed.txt"), "seed\n");
    git(tree, "add", "-A");
    git(
      tree,
      "-c",
      "user.name=probe",
      "-c",
      "user.email=probe@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "seed",
    );
    const linked = join(tree, "..", `${basename(tree)}-linked`);
    roots.push(linked);
    git(tree, "worktree", "add", "-q", "--detach", linked);
    expect(ensureContextIgnored(linked).kind).toBe("excluded");
    expect(contextLines(excludeOf(tree))).toBe(1);
  });

  test("leaves a nested .context/ visible", () => {
    const tree = repo();
    mkdirSync(join(tree, "pkg", ".context"), { recursive: true });
    writeFileSync(join(tree, "pkg", ".context", "note.md"), "mine\n");
    ensureContextIgnored(tree);
    expect(untracked(tree)).toBe("?? pkg/");
  });

  test("excludes the root's .context/ when started in a subdirectory that ignores its own", () => {
    const tree = repo();
    const nested = join(tree, "packages", "app");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, ".gitignore"), ".context/\n");
    expect(ensureContextIgnored(nested).kind).toBe("excluded");
    expect(contextLines(excludeOf(tree))).toBe(1);
  });

  test("reports a rule a later negation defeats", () => {
    const tree = repo();
    writeFileSync(
      join(tree, ".git", "info", "exclude"),
      `${CONTEXT_PATTERN}\n!${CONTEXT_PATTERN}\n`,
    );
    const outcome = ensureContextIgnored(tree);
    expect(outcome.kind).toBe("failed");
  });

  test("hides the drive's files and nothing else", () => {
    const tree = repo();
    mkdirSync(join(tree, ".context", "drive-mailbox"), { recursive: true });
    writeFileSync(join(tree, ".context", "pr-drive-42.md"), "handoff\n");
    writeFileSync(join(tree, ".context", "drive-mailbox", "inbox.jsonl"), "");
    writeFileSync(join(tree, "stray.txt"), "left over\n");
    expect(untracked(tree)).toContain(".context/");
    ensureContextIgnored(tree);
    expect(untracked(tree)).toBe("?? stray.txt");
  });
});

describe("drive.ts in a repository that does not ignore .context/", () => {
  function fresh(): Clone {
    const c = makeClone();
    roots.push(c.root);
    Object.assign(c.env, isolated, {
      HOME: c.env.HOME,
      USERPROFILE: c.env.HOME,
    });
    // The fixture's own exclude stands in for a repository's rule; drop it.
    writeFileSync(join(c.primary, ".git", "info", "exclude"), "");
    return c;
  }

  /** A tree holding the drive's handoff and mailbox, as a drive leaves it. */
  function treeWithDriveFiles(c: Clone): string {
    const tree = c.tree("wt1");
    mkdirSync(join(tree, ".context", "drive-mailbox"), { recursive: true });
    writeFileSync(join(tree, ".context", "pr-drive-42.md"), "handoff\n");
    writeFileSync(join(tree, ".context", "drive-mailbox", "inbox.jsonl"), "");
    return tree;
  }

  const drive = (c: Clone, tree: string) =>
    c.script(tree, "drive.ts", "42", "--", "true", "42");

  test("attaches over its own files, and arming again adds no second line", () => {
    const c = fresh();
    const tree = treeWithDriveFiles(c);
    const first = drive(c, tree);
    expect(first.stderr).toContain("attach: PR #42 on 'feature'");
    expect(first.stderr).not.toContain("uncommitted changes");
    expect(first.stderr).toContain(`does not ignore ${CONTEXT_PATTERN}`);
    drive(c, tree);
    expect(contextLines(excludeOf(c.primary))).toBe(1);
  });

  test("attaches alone over its own files", () => {
    const c = fresh();
    const tree = treeWithDriveFiles(c);
    const r = c.attach(tree, "42");
    expectSpawnExit(r, 0, "attach-pr.ts");
    expect(contextLines(excludeOf(c.primary))).toBe(1);
  });

  test("still refuses an untracked file outside .context/", () => {
    const c = fresh();
    const tree = treeWithDriveFiles(c);
    writeFileSync(join(tree, "scratch.txt"), "left over\n");
    const r = drive(c, tree);
    expectSpawnExit(r, 2, "drive.ts");
    expect(r.stderr).toContain("uncommitted changes");
    expect(r.stderr).toContain("scratch.txt");
    expect(r.stderr).not.toContain("?? .context/");
  });
});
