/**
 * Scratch git repositories for the resolve-conflicts suites. Every git call
 * and script run goes through the guarded spawn with an explicit environment
 * that carries no variable able to route git at this repository, and with
 * the user's own git configuration replaced by a fixed one.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";

const SCRIPTS = join(import.meta.dir, "..", "scripts");

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export class Scratch {
  readonly root: string;
  readonly home: string;
  readonly env: Record<string, string>;

  constructor(prefix = "resolve-conflicts-") {
    this.home = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    this.root = join(this.home, "repo");
    mkdirSync(this.root);
    const config = join(this.home, "gitconfig");
    writeFileSync(
      config,
      [
        "[user]",
        "\tname = Scratch",
        "\temail = scratch@example.invalid",
        "[core]",
        "\tautocrlf = false",
        "[init]",
        "\tdefaultBranch = main",
        "[advice]",
        "\tdetachedHead = false",
        "",
      ].join("\n"),
    );
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key.toUpperCase().startsWith("GIT_")) continue;
      if (key.startsWith("JIG_")) continue;
      env[key] = value;
    }
    this.env = {
      ...env,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      GIT_MERGE_AUTOEDIT: "no",
    };
    this.git("init", "-q");
  }

  run(command: string, args: string[], cwd = this.root): Run {
    const r = spawnSync(command, args, { cwd, env: this.env });
    if (r.error) throw r.error;
    return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
  }

  /** Run git; any failure throws. */
  git(...args: string[]): string {
    const r = this.run("git", args);
    if (r.code !== 0)
      throw new Error(`git ${args.join(" ")} exited ${r.code}: ${r.stderr}`);
    return r.stdout;
  }

  /** Run git where a non-zero exit is expected (a merge that conflicts). */
  gitTry(...args: string[]): Run {
    return this.run("git", args);
  }

  write(path: string, content: string): void {
    const full = join(this.root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  read(path: string): string {
    return readFileSync(join(this.root, path), "utf8");
  }

  /** Write the files and commit them (and any other change) with `message`. */
  commit(message: string, files: Record<string, string> = {}): string {
    for (const [path, content] of Object.entries(files))
      this.write(path, content);
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
    return this.git("rev-parse", "HEAD").trim();
  }

  /** Run one of this skill's scripts (or a script at an absolute path). */
  script(name: string, args: string[] = [], cwd = this.root): Run {
    const path =
      name.startsWith("/") || /^[A-Za-z]:/.test(name)
        ? name
        : join(SCRIPTS, name);
    return this.run(process.execPath, [path, ...args], cwd);
  }

  snapshot(): Record<string, unknown> {
    const path = this.git(
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "jig/conflicts.json",
    ).trim();
    return JSON.parse(readFileSync(path, "utf8"));
  }

  overlay(text: string): void {
    this.write(".config/jig.yaml", text);
  }

  cleanup(): void {
    rmSync(this.home, { recursive: true, force: true });
  }
}

export const CONFIG_BASE = `export const config = {
  retries: 3,
  timeout: 1000,
  name: "service",
};

export function describe() {
  return "plain";
}
`;

/**
 * A merge of `main` into `feature` stopped on one conflict in src/config.ts.
 *
 * - main raises the retry limit (`retries: 5`), and separately changes
 *   describe() further down, a region git merges cleanly;
 * - feature adds a `timeoutOverride` option right below the retry limit.
 *
 * The correct resolution keeps both: `retries: 5` and the new option.
 */
export function mergeConflict(s: Scratch, style = "diff3"): void {
  s.commit("Add the service configuration", { "src/config.ts": CONFIG_BASE });
  s.git("checkout", "-q", "-b", "feature");
  s.commit("Add a timeout override option", {
    "src/config.ts": CONFIG_BASE.replace(
      "  retries: 3,\n",
      "  retries: 3,\n  timeoutOverride: true,\n",
    ),
  });
  s.git("checkout", "-q", "main");
  s.commit("Raise the retry limit (#15)", {
    "src/config.ts": CONFIG_BASE.replace("retries: 3", "retries: 5"),
  });
  s.commit("Describe the service in detail", {
    "src/config.ts": CONFIG_BASE.replace("retries: 3", "retries: 5").replace(
      'return "plain"',
      'return "detailed"',
    ),
  });
  s.git("checkout", "-q", "feature");
  const merge = s.gitTry("-c", `merge.conflictStyle=${style}`, "merge", "main");
  if (merge.code === 0) throw new Error("the fixture merge did not conflict");
}

/** The resolution that keeps both sides' changes. */
export const CONFIG_COMBINED = CONFIG_BASE.replace(
  "  retries: 3,\n",
  "  retries: 5,\n  timeoutOverride: true,\n",
).replace('return "plain"', 'return "detailed"');
