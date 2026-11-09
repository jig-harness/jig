import { expect, test } from "bun:test";
import {
  parseBootstrap,
  requireVersion,
  githubRepository,
} from "./bootstrap.ts";

test("bootstrap previews by default and keeps setup selection intact", () => {
  expect(
    parseBootstrap([
      "--codex",
      "--source",
      "https://github.com/example-org/example-repo.git#v1.2.3",
    ]),
  ).toEqual({
    apply: false,
    setup: [
      "--codex",
      "--source",
      "https://github.com/example-org/example-repo.git#v1.2.3",
    ],
  });
  expect(parseBootstrap(["--apply", "--channel", "stable"]).apply).toBe(true);
  expect(() => parseBootstrap(["--unknown"])).toThrow("unknown argument");
});
test("version preflight refuses an old tool before installation", () => {
  expect(() => requireVersion("git", "git version 2.35.0", "2.36.0")).toThrow(
    "requires",
  );
  expect(() => requireVersion("gh", "unexpected", "2.48.0")).toThrow(
    "unreadable",
  );
  expect(() =>
    requireVersion("git", "git version 2.50.0", "2.36.0"),
  ).not.toThrow();
});
test("repository access checks cannot be redirected to another API host", () => {
  expect(
    githubRepository("https://github.com/example-org/example-repo.git#v1.2.3"),
  ).toBe("example-org/example-repo");
  expect(githubRepository(import.meta.dirname)).toBeNull();
  expect(() => githubRepository("/missing/marketplace")).toThrow(
    "GitHub HTTPS",
  );
  expect(githubRepository("example-org/example-repo#v1.2.3")).toBe(
    "example-org/example-repo",
  );
  expect(() =>
    githubRepository("https://github.com.evil.test/example-org/example-repo"),
  ).toThrow("GitHub HTTPS");
  expect(() =>
    githubRepository("https://github.com/example-org/example-repo?redirect=x"),
  ).toThrow("GitHub HTTPS");
});

import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, delimiter, join } from "node:path";
import { writeFakeProgram } from "../../lib/test-helpers/fake-program.ts";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jig-bootstrap-"));
  const log = join(root, "calls.jsonl");
  const state = join(root, "state.json");
  writeFileSync(log, "");
  writeFileSync(state, JSON.stringify({ registered: null, installed: false }));
  const fake = (tool: string, body: string) =>
    writeFakeProgram(
      join(root, tool),
      `#!/usr/bin/env bun
import { appendFileSync,readFileSync,writeFileSync } from 'node:fs';
const args=process.argv.slice(2); const key=args.join(' ');
appendFileSync(${JSON.stringify(log)},JSON.stringify([${JSON.stringify(tool)},...args])+'\\n');
${body}
`,
    );
  fake(
    "git",
    "if(key==='--version')console.log('git version 2.50.0');else if(args[0]==='ls-remote')process.exit(process.env.NO_STABLE==='1'?2:0);else process.exit(1);",
  );
  fake(
    "gh",
    "if(key==='--version')console.log('gh version 2.80.0');else if(args[0]==='auth'){if(process.env.NO_AUTH==='1'){console.log('credential helper unavailable');process.exit(7);}}else if(args[0]==='api')console.log(args.includes('user')?'test-user':'example-org/example-repo');else process.exit(1);",
  );
  fake(
    "codex",
    `const file=${JSON.stringify(state)};const state=JSON.parse(readFileSync(file,'utf8'));
if(key==='--version')console.log('codex-cli 0.159.0');
else if(key==='plugin marketplace list --json')console.log(JSON.stringify({marketplaces:state.registered?[{name:'jig',marketplaceSource:{sourceType:'git',source:state.registered}}]:[]}));
else if(key==='plugin list --json')console.log(JSON.stringify({installed:state.installed?[{pluginId:'jig@jig',version:'0.169.0',enabled:true}]:[]}));
else if(args.slice(0,3).join(' ')==='plugin marketplace add'){state.registered=args[3];const ref=args[args.indexOf('--ref')+1];writeFileSync(${JSON.stringify(join(root, "config.toml"))},'[marketplaces.jig]\\nref="'+ref+'"\\n');}
else if(key==='plugin add jig@jig')state.installed=true;
else if(key!=='plugin marketplace upgrade jig')process.exit(1);
writeFileSync(file,JSON.stringify(state));`,
  );
  return {
    root,
    setState: (registered: string, ref: string) => {
      writeFileSync(state, JSON.stringify({ registered, installed: true }));
      writeFileSync(
        join(root, "config.toml"),
        `[marketplaces.jig]\nref="${ref}"\n`,
      );
    },
    run: (args: string[], extra: Record<string, string> = {}) => {
      writeFileSync(log, "");
      const result = Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dirname, "bootstrap.ts"),
          "--codex",
          ...args,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            ...extra,
            HOME: root,
            USERPROFILE: root,
            CODEX_HOME: root,
            JIG_MARKETPLACE: "",
            PATH: [root, dirname(process.execPath)].join(delimiter),
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        },
      );
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      return {
        ...result,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        calls,
      };
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("fresh preview authenticates and checks access without marketplace writes", () => {
  const f = fixture();
  try {
    const result = f.run([]);
    expectSpawnExit(result, 0);
    expect(result.stdout).toContain("Preview only");
    expect(result.stdout).toContain("#stable");
    expect(result.calls.some((c) => c.includes("repos/jig-harness/jig"))).toBe(
      true,
    );
    expect(
      result.calls
        .filter((c) => c[0] === "codex")
        .every((c) => c.includes("--version") || c.includes("--json")),
    ).toBe(true);
  } finally {
    f.close();
  }
});
test("fresh apply uses stable fallback and reports the installed plugin", () => {
  const f = fixture();
  try {
    const result = f.run(["--apply"], { NO_STABLE: "1" });
    expectSpawnExit(result, 0);
    expect(result.stdout).toContain("0.169.0 enabled");
    expect(result.calls.filter((call) => call[1] === "ls-remote")).toHaveLength(
      1,
    );
    expect(result.calls).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "add",
      "https://github.com/jig-harness/jig.git",
      "--ref",
      "latest",
    ]);
    expect(
      result.calls.some((c) => c.includes("install") || c.includes("login")),
    ).toBe(false);
  } finally {
    f.close();
  }
});
test("reruns preserve custom source and tag pins and still update the marketplace", () => {
  const f = fixture();
  try {
    f.setState("https://github.com/example-org/example-repo.git", "v1.2.3");
    const result = f.run(["--apply"]);
    expectSpawnExit(result, 0);
    expect(result.stdout).toContain("v1.2.3, pinned");
    expect(result.calls).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "upgrade",
      "jig",
    ]);
    expect(
      result.calls.some((c) => c[2] === "marketplace" && c[3] === "add"),
    ).toBe(false);
  } finally {
    f.close();
  }
});
test("authentication and source conflicts stop before agent writes", () => {
  const f = fixture();
  try {
    let result = f.run(["--apply"], { NO_AUTH: "1" });
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain("Authenticate explicitly");
    expect(result.stderr).toContain("credential helper unavailable");
    expect(result.stderr).toContain("exit 7");
    expect(result.calls.some((c) => c[0] === "codex")).toBe(false);
    f.setState("https://github.com/jig-harness/jig.git", "latest");
    result = f.run(["--apply", "--channel", "stable"]);
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain("registered from");
    expect(
      result.calls
        .filter((c) => c[0] === "codex")
        .every((c) => c.includes("--version") || c.includes("--json")),
    ).toBe(true);
  } finally {
    f.close();
  }
});

test("explicit shorthand reruns preserve the existing registration and pin", () => {
  const f = fixture();
  try {
    f.setState("example-org/example-repo", "v1.2.3");
    const result = f.run(["--apply", "--source", "example-org/example-repo"]);
    expectSpawnExit(result, 0);
    expect(result.calls).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "upgrade",
      "jig",
    ]);
    expect(
      result.calls.some(
        (call) =>
          call[1] === "plugin" &&
          call[2] === "marketplace" &&
          call[3] === "add",
      ),
    ).toBe(false);
  } finally {
    f.close();
  }
});

test("fresh shorthand checks and installs the remote despite a regular file collision", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "example-org"));
    writeFileSync(join(f.root, "example-org/example-repo"), "local file");
    const result = f.run(["--apply", "--source", "example-org/example-repo"]);
    expectSpawnExit(result, 0);
    expect(
      result.calls.some((call) =>
        call.includes("repos/example-org/example-repo"),
      ),
    ).toBe(true);
    expect(result.calls).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "add",
      "https://github.com/example-org/example-repo",
    ]);
  } finally {
    f.close();
  }
});

test.each([
  "https://github.com/example-org/example-repo",
  "example-org/example-repo#v1.2.3",
])(
  "registered shorthand stays remote despite a directory collision: %s",
  (source) => {
    const f = fixture();
    try {
      f.setState("example-org/example-repo", "v1.2.3");
      mkdirSync(join(f.root, "example-org/example-repo"), { recursive: true });
      const result = f.run(["--apply", "--source", source]);
      expectSpawnExit(result, 0);
      expect(result.calls).toContainEqual([
        "codex",
        "plugin",
        "marketplace",
        "upgrade",
        "jig",
      ]);
      expect(
        result.calls.some((call) =>
          call.includes("repos/example-org/example-repo"),
        ),
      ).toBe(true);
    } finally {
      f.close();
    }
  },
);

test("unpinned Git registrations still require remote access when a directory collides", () => {
  const f = fixture();
  try {
    f.setState("example-org/example-repo", "main");
    // No ref in either the registration address or its config.
    writeFileSync(join(f.root, "config.toml"), "");
    mkdirSync(join(f.root, "example-org/example-repo"), { recursive: true });
    const result = f.run([
      "--apply",
      "--source",
      "https://github.com/example-org/example-repo",
    ]);
    expectSpawnExit(result, 0);
    expect(
      result.calls.some((call) =>
        call.includes("repos/example-org/example-repo"),
      ),
    ).toBe(true);
  } finally {
    f.close();
  }
});

test("fresh shorthand sources register the same HTTPS repository checked for access", () => {
  const f = fixture();
  try {
    const result = f.run([
      "--apply",
      "--source",
      "example-org/example-repo#v1.2.3",
    ]);
    expectSpawnExit(result, 0);
    expect(result.calls).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "add",
      "https://github.com/example-org/example-repo",
      "--ref",
      "v1.2.3",
    ]);
    const rerun = f.run([
      "--apply",
      "--source",
      "example-org/example-repo#v1.2.3",
    ]);
    expectSpawnExit(rerun, 0);
    expect(rerun.calls).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "upgrade",
      "jig",
    ]);
    expect(
      result.calls.some((call) =>
        call.includes("repos/example-org/example-repo"),
      ),
    ).toBe(true);
  } finally {
    f.close();
  }
});
