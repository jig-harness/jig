import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "./expect-spawn-exit.ts";
import { shebangInterpreter, writeFakeProgram } from "./fake-program.ts";
import { scriptArgv } from "./script-argv.ts";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-program-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Runs the bare name `name` with `dir` first on PATH, as the code under test does. */
function run(
  dir: string,
  name: string,
  args: string[] = [],
  options: { stdin?: string; env?: Record<string, string> } = {},
) {
  return Bun.spawnSync([name, ...args], {
    env: {
      ...process.env,
      ...options.env,
      PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
    },
    stdin: options.stdin === undefined ? undefined : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("writeFakeProgram", () => {
  test("a shell fake is found by its bare name and receives arguments, environment and stdin", () => {
    const dir = scratch();
    writeFakeProgram(
      join(dir, "jig-fake-sh"),
      '#!/bin/sh\nprintf "args=%s env=%s stdin=%s\\n" "$*" "$FAKE_VALUE" "$(cat)"\necho err >&2\nexit 3\n',
    );
    const r = run(dir, "jig-fake-sh", ["a", "b c"], {
      stdin: "in",
      env: { FAKE_VALUE: "v" },
    });
    expectSpawnExit(r, 3, "exit status");
    expect(r.stdout.toString()).toBe("args=a b c env=v stdin=in\n");
    expect(r.stderr.toString()).toBe("err\n");
  });

  test("a bash fake and a bun fake run through their own interpreter", () => {
    const dir = scratch();
    writeFakeProgram(
      join(dir, "jig-fake-bash"),
      '#!/usr/bin/env bash\nset -euo pipefail\n[[ "$1" == x ]] && echo bash-ok\n',
    );
    writeFakeProgram(
      join(dir, "jig-fake-bun"),
      "#!/usr/bin/env bun\nconsole.log('bun-ok', process.argv.slice(2).join(','));\nprocess.exit(4);\n",
    );
    const bash = run(dir, "jig-fake-bash", ["x"]);
    expectSpawnExit(bash, 0, "bash fake");
    expect(bash.stdout.toString()).toBe("bash-ok\n");
    const bun = run(dir, "jig-fake-bun", ["p", "q"]);
    expectSpawnExit(bun, 4, "bun fake");
    expect(bun.stdout.toString()).toBe("bun-ok p,q\n");
  });

  test("a fake still finds its interpreter when the caller narrows PATH to the fake's directory", () => {
    const dir = scratch();
    writeFakeProgram(join(dir, "jig-fake-narrow"), "#!/bin/sh\necho narrow\n");
    const r = Bun.spawnSync(["jig-fake-narrow"], {
      env: { PATH: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(r, 0, "narrow PATH");
    expect(r.stdout.toString()).toBe("narrow\n");
  });

  test("writing a fake again replaces its body", () => {
    const dir = scratch();
    const path = join(dir, "jig-fake-twice");
    writeFakeProgram(path, "#!/bin/sh\necho first\n");
    writeFakeProgram(path, "#!/bin/sh\necho second\n");
    expect(run(dir, "jig-fake-twice").stdout.toString()).toBe("second\n");
  });

  test("a script without a recognised shebang is refused", () => {
    expect(() => writeFakeProgram(join(scratch(), "x"), "echo hi\n")).toThrow(
      /starts with a #!/,
    );
  });
});

// The Windows layout (a compiled executable and a sidecar) is built here on
// every platform, so the shim is tested wherever the suite runs; the plain
// script layout is POSIX's, and Windows cannot run it.
describe.each(process.platform === "win32" ? [true] : [false, true])(
  "writeFakeProgram, shim %p",
  (shim) => {
    const write = (dir: string, name: string, source: string) =>
      writeFakeProgram(join(dir, name), source, { shim });
    const bare = (name: string) => (shim ? `${name}.exe` : name);

    test("a shell fake receives every argument exactly as it was passed", () => {
      const dir = scratch();
      write(dir, "jig-fake-args", "#!/bin/sh\nprintf '<%s>\\n' \"$@\"\n");
      const args = [
        '.owner.login + "/" + .name',
        "repos/{owner}/{repo}/commits/*",
        "",
        "two words",
        "a\\b",
        "/c/not/a/path",
        "--flag=/x/y",
        "it's",
        "line\nbreak",
      ];
      const r = Bun.spawnSync([join(dir, bare("jig-fake-args")), ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expectSpawnExit(r, 0, "arguments");
      expect(r.stdout.toString()).toBe(args.map((a) => `<${a}>\n`).join(""));
    });

    test("a shell fake is found by its bare name, reads stdin and exits with its own status", () => {
      const dir = scratch();
      write(
        dir,
        "jig-fake-both",
        '#!/bin/sh\nprintf "in=%s\\n" "$(cat)"\nexit 5\n',
      );
      const r = run(dir, bare("jig-fake-both"), [], { stdin: "payload" });
      expectSpawnExit(r, 5, "exit status");
      expect(r.stdout.toString()).toBe("in=payload\n");
    });

    test("a shell fake keeps its own $0, so it can call itself", () => {
      const dir = scratch();
      write(
        dir,
        "jig-fake-self",
        '#!/bin/sh\nif [ "$1" = inner ]; then echo "inner:$2"; exit 0; fi\nprintf "outer:%s\\n" "$("$0" inner "$1")"\n',
      );
      const r = run(dir, bare("jig-fake-self"), ["x y"]);
      expect(r.stdout.toString()).toBe("outer:inner:x y\n");
    });

    test("a bun fake receives its arguments", () => {
      const dir = scratch();
      write(
        dir,
        "jig-fake-bunargs",
        "#!/usr/bin/env bun\nconsole.log(JSON.stringify(process.argv.slice(2)));\n",
      );
      const args = ['x "y" z', "{a}", ""];
      const r = run(dir, bare("jig-fake-bunargs"), args);
      expect(JSON.parse(r.stdout.toString())).toEqual(args);
    });
  },
);

describe("shebangInterpreter", () => {
  test.each([
    ["#!/bin/sh\n", "sh"],
    ["#!/usr/bin/env bash\n", "bash"],
    ["#!/usr/bin/env bun\n", "bun"],
    ["#!/Users/x/.bun/bin/bun\n", "bun"],
    ["#!C:\\tools\\bun\\bin\\bun.exe\n", "bun"],
  ])("%j names %s", (source, expected) => {
    expect<string>(shebangInterpreter(source)).toBe(expected);
  });

  test("another interpreter is refused", () => {
    expect(() => shebangInterpreter("#!/usr/bin/python3\n")).toThrow(
      /starts with a #!/,
    );
  });

  // The shim runs the interpreter on the script alone, so an option would be
  // honoured on POSIX and dropped on Windows.
  test.each([
    "#!/bin/sh -e\n",
    "#!/usr/bin/env bash -eu\n",
    "#!/usr/bin/env bun --smol\n",
  ])("a shebang with options, %j, is refused", (source) => {
    expect(() => shebangInterpreter(source)).toThrow(/without options/);
  });
});

describe("scriptArgv", () => {
  test("runs a script through Bun on Windows and directly elsewhere", () => {
    const argv = scriptArgv("/s/x.ts", "a", "b");
    expect(argv).toEqual(
      process.platform === "win32"
        ? [process.execPath, "/s/x.ts", "a", "b"]
        : ["/s/x.ts", "a", "b"],
    );
  });
});
