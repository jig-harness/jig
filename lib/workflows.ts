/** The one reader of CI workflow files for Jig's gates: it lists GitHub
 * Actions workflows and composite actions, and parses each file with js-yaml,
 * vendored beside this file. js-yaml rejects a repeated key where Bun's parser
 * keeps the last one, so a duplicated job or step cannot hide behind its
 * second copy. The PR-target safety lint (`module-gates.ts`) and M13's
 * workflow-convention lint read workflows only through this module. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "./vendor/js-yaml.mjs";

/** A folder's YAML files; `missing` when the folder does not exist, `error`
 * when it exists but cannot be read. */
export type Listing =
  | { files: string[] }
  | { missing: true }
  | { error: string };

const YAML_FILE = /\.ya?ml$/;
const ACTION_FILE = /^action\.ya?ml$/;

function folder(dir: string): Listing | undefined {
  try {
    if (!statSync(dir).isDirectory())
      return { error: `not a directory: ${dir}` };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { missing: true };
    return { error: `cannot inspect ${dir}: ${String(e)}` };
  }
  return undefined;
}

/** The workflow files directly under `dir` (`*.yml`, `*.yaml`), sorted. */
export function workflowFiles(dir: string): Listing {
  const problem = folder(dir);
  if (problem) return problem;
  try {
    return {
      files: readdirSync(dir)
        .filter((f) => YAML_FILE.test(f))
        .sort()
        .map((f) => join(dir, f)),
    };
  } catch (e) {
    return { error: `cannot scan ${dir}: ${String(e)}` };
  }
}

/** The composite-action definitions under `dir` at any depth
 * (`action.yml`, `action.yaml`), sorted; an installed dependency under
 * `node_modules/` is not the repository's own action. */
export function actionFiles(dir: string): Listing {
  const problem = folder(dir);
  if (problem) return problem;
  try {
    return {
      files: readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((f) => {
          const parts = f.split(/[\\/]/);
          return (
            !parts.includes("node_modules") &&
            ACTION_FILE.test(parts.pop() ?? "")
          );
        })
        .sort()
        .map((f) => join(dir, f)),
    };
  } catch (e) {
    return { error: `cannot scan ${dir}: ${String(e)}` };
  }
}

/** A parsed YAML file: its text, for line numbers, and its document. */
export interface YamlFile {
  path: string;
  raw: string;
  doc: unknown;
}

/** Read and parse one YAML file, or say why it cannot be read as YAML. */
export function readYaml(path: string): YamlFile | { error: string } {
  let raw: string;
  try {
    if (!statSync(path).isFile()) return { error: `not a file: ${path}` };
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { error: `cannot read ${path}: ${String(e)}` };
  }
  try {
    return { path, raw, doc: loadYaml(raw) };
  } catch (e) {
    return { error: `cannot parse ${path} as YAML: ${String(e)}` };
  }
}
