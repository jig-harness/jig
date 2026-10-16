/**
 * Scratch repositories sharing one Jig home and one reflection store, for
 * the reflection suites. Every git call and script run goes through the
 * guarded spawn with an explicit environment that carries no variable able
 * to route git at this repository, and with a fixed git configuration.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";

const REFLECT = join(import.meta.dir, "..", "scripts");
const REVIEW = join(
  import.meta.dir,
  "..",
  "..",
  "review-reflections",
  "scripts",
);

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** A Jig home, a store folder, and the environment the scripts run under. */
export class Machine {
  readonly dir: string;
  readonly home: string;
  readonly store: string;
  readonly env: Record<string, string>;

  constructor() {
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), "reflect-")));
    this.home = join(this.dir, "jig-home");
    this.store = join(this.dir, "store");
    mkdirSync(this.home);
    const gitconfig = join(this.dir, "gitconfig");
    writeFileSync(
      gitconfig,
      "[user]\n\tname = Scratch\n\temail = scratch@example.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n",
    );
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (key.toUpperCase().startsWith("GIT_") || key.startsWith("JIG"))
        continue;
      // The harness markers would make the measured session differ by machine.
      if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) continue;
      if (key.startsWith("CONDUCTOR_") || key.startsWith("CODEX_")) continue;
      env[key] = value;
    }
    this.env = {
      ...env,
      JIG_HOME: this.home,
      GIT_CONFIG_GLOBAL: gitconfig,
      GIT_CONFIG_NOSYSTEM: "1",
    };
  }

  /** The user layer: reflection on, into this machine's store. */
  userConfig(
    text = `reflection:\n  path: ${JSON.stringify(this.store)}\n`,
  ): void {
    writeFileSync(join(this.home, "jig.yaml"), text);
  }

  run(
    command: string,
    args: string[],
    cwd: string,
    stdin?: string,
    env = this.env,
  ): Run {
    const r = spawnSync(command, args, {
      cwd,
      env,
      input: stdin,
      encoding: "utf8",
    });
    if (r.error) throw r.error;
    return {
      code: r.status ?? -1,
      stdout: String(r.stdout),
      stderr: String(r.stderr),
    };
  }

  /** A repository with an `origin` remote, a first commit and a branch. */
  repository(name: string, remote: string | null, branch = "main"): Repo {
    const root = join(this.dir, name);
    mkdirSync(root, { recursive: true });
    const repo = new Repo(this, root);
    repo.git("init", "-q");
    if (remote !== null) repo.git("remote", "add", "origin", remote);
    repo.commit("init");
    if (branch !== "main") repo.git("checkout", "-q", "-b", branch);
    return repo;
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export class Repo {
  readonly machine: Machine;
  readonly root: string;

  constructor(machine: Machine, root: string) {
    this.machine = machine;
    this.root = root;
  }

  git(...args: string[]): string {
    const r = this.machine.run("git", args, this.root);
    if (r.code !== 0)
      throw new Error(`git ${args.join(" ")} exited ${r.code}: ${r.stderr}`);
    return r.stdout;
  }

  write(path: string, content: string): void {
    const full = join(this.root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  commit(message: string, files: Record<string, string> = {}): string {
    for (const [path, content] of Object.entries(files))
      this.write(path, content);
    this.git("add", "-A");
    this.git("commit", "-q", "--allow-empty", "-m", message);
    return this.git("rev-parse", "HEAD").trim();
  }

  /** Run a script of `reflect` (or, with `dir`, another skill's). */
  script(
    name: string,
    args: string[] = [],
    stdin?: string,
    dir = REFLECT,
    env?: Record<string, string>,
  ): Run {
    return this.machine.run(
      process.execPath,
      [join(dir, name), ...args],
      this.root,
      stdin,
      env,
    );
  }

  review(args: string[], stdin?: string): Run {
    return this.script("review.ts", args, stdin, REVIEW);
  }

  /** `script`, failing the test with its stderr unless it exits 0; parsed stdout. */
  json(
    name: string,
    args: string[] = [],
    stdin?: string,
    dir = REFLECT,
  ): unknown {
    const r = this.script(name, args, stdin, dir);
    if (r.code !== 0)
      throw new Error(
        `${name} ${args.join(" ")} exited ${r.code}: ${r.stderr}`,
      );
    return JSON.parse(r.stdout);
  }

  note(finding: Record<string, unknown>, args: string[] = []): string {
    const out = this.json(
      "journal.ts",
      ["note", ...args],
      JSON.stringify(finding),
    ) as { id: string };
    return out.id;
  }
}

/** A finding as an agent notes it. */
export function finding(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "error",
    severity: "medium",
    class: "instruction-missing-precondition",
    target: { scope: "repository", name: "AGENTS.md" },
    title: "The setup step assumed a running database",
    description:
      "The instructions never say the database must be started first.",
    suggested_fix: "Add the start command to the setup section.",
    ...overrides,
  };
}

/** A finding about one of Jig's skills. */
export function toolFinding(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return finding({
    class: "narrow-fix-per-round",
    target: { scope: "tool", tool: "jig", name: "drive-pr" },
    title: "Each round fixed one instance of the same problem",
    ...overrides,
  });
}
