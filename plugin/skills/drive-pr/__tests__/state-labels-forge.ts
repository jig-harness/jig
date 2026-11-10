/**
 * A forge for the drive's own state label, in front of another fake `gh`:
 * it serves the repository, its default branch's `.config/jig.yaml`, the pull
 * request's labels and head, and the label edits, and passes every other
 * call to the `gh` it stands in front of.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

/** The default branch's configuration with the labels on, as the forge serves it. */
const LABELS_ON = "dispatch:\n  labels:\n    enabled: true\n";

/**
 * A `gh` that serves the repository and its default branch's
 * `.config/jig.yaml` (`jig.yaml` beside it), keeps the pull request's labels
 * in `labels.json` and its head in `head` (the label read's own), logs each
 * label edit to `edits.log`, refuses one while `edit-refused` exists, and
 * runs the stub forge for everything else.
 */
const LABEL_GH = (stub: string) => `#!/usr/bin/env bun
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
const file = path.join(dir, "labels.json");
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (args[0] === "repo" && args[1] === "view" && args.at(-1) === "nameWithOwner,defaultBranchRef")
  out({ nameWithOwner: "example/project", defaultBranchRef: { name: "main" } });
if (args[0] === "api" && args[1] === "repos/example/project/contents/.config/jig.yaml?ref=main")
  out({ encoding: "base64", content: fs.readFileSync(path.join(dir, "jig.yaml")).toString("base64") });
if (args[0] === "pr" && args[1] === "view" && args.at(-2) === "--json" && args.at(-1) === "labels,headRefOid")
  out({ labels: read().map((name) => ({ name })), headRefOid: fs.readFileSync(path.join(dir, "head"), "utf8") });
const values = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
const add = values("--add-label");
const remove = values("--remove-label");
if (args[0] === "pr" && args[1] === "edit" && [...add, ...remove].some((l) => l.startsWith("jig:"))) {
  fs.appendFileSync(path.join(dir, "edits.log"), JSON.stringify({ add, remove }) + "\\n");
  if (fs.existsSync(path.join(dir, "edit-refused"))) {
    process.stderr.write("could not add label: 'jig:driving' not found\\n");
    process.exit(1);
  }
  fs.writeFileSync(file, JSON.stringify([...read().filter((l) => !remove.includes(l)), ...add]));
  process.exit(0);
}
const child = require("node:child_process").spawnSync(${JSON.stringify(stub)}, args, { stdio: "inherit" });
process.exit(child.status ?? 1);
`;

/**
 * A label forge in `dir/label-bin`, in front of the `gh` at `stub`, its pull
 * request carrying `labels` at head `head`; put `bin` first on `PATH`.
 */
export function labelForge(
  dir: string,
  stub: string,
  labels: string[],
  head: string,
) {
  const bin = join(dir, "label-bin");
  mkdirSync(bin, { recursive: true });
  writeFakeProgram(join(bin, "gh"), LABEL_GH(stub));
  writeFileSync(join(bin, "labels.json"), JSON.stringify(labels));
  writeFileSync(join(bin, "jig.yaml"), LABELS_ON);
  writeFileSync(join(bin, "head"), head);
  return {
    bin,
    labels: (): string[] =>
      JSON.parse(readFileSync(join(bin, "labels.json"), "utf8")),
    edits: (): Array<{ add: string[]; remove: string[] }> =>
      existsSync(join(bin, "edits.log"))
        ? readFileSync(join(bin, "edits.log"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l))
        : [],
  };
}
