import { test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
const cases: [number, string, string[]][] = [
  [0, "unique ADR numbers pass", ["$fix/unique"]],
  [1, "duplicate ADR number fails", ["$fix/dupe"]],
  [0, "missing ADR dir passes", ["$fix/none"]],
];
for (const [want, label, params] of cases) {
  test(label, () => {
    let args = params.map((value) =>
      value.replace("$fix", join(import.meta.dir, "fixtures")),
    );
    const env = { ...process.env, NEW_DOCS: "", STRICT: "0", ADR_DIR: "" };
    if (args[0] === "--new") {
      env.NEW_DOCS = args[1] ?? "";
      args = args.slice(2);
    }
    if (args[0] === "--strict") {
      env.STRICT = "1";
      args = args.slice(1);
    }
    env.ADR_DIR = args[0] ?? "";
    args = [];
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "check-adr-numbers.ts"),
        ...args,
      ],
      { env },
    );
    expectSpawnExit(result, want);
  });
}
