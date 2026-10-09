/**
 * Preserve the operated YAML parser behind a typed packaging boundary.
 *
 * The plugin runs from the harness's plugin cache, which has no
 * `node_modules`, so the parser is vendored as js-yaml's own ESM build.
 * Bun's built-in parser is not a substitute: it keeps the last of two
 * duplicated keys where js-yaml rejects the document.
 */
import { load as parse } from "./vendor/js-yaml.mjs";

export function load(text: string): unknown {
  return parse(text);
}
