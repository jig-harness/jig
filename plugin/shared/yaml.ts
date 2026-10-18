/**
 * Preserve the operated YAML parser behind a typed packaging boundary.
 *
 * The plugin runs from the harness's plugin cache, which has no
 * `node_modules`, so the parser is vendored as js-yaml's own ESM build.
 * Bun's built-in parser is not a substitute: it keeps the last of two
 * duplicated keys where js-yaml rejects the document.
 */
import { dump as write, load as parse } from "./vendor/js-yaml.mjs";

export function load(text: string): unknown {
  return parse(text);
}

/** How `dump` writes: the subset of js-yaml's options the skills use. */
export interface DumpOptions {
  /** Write every mapping's keys in sorted order. */
  sortKeys?: boolean;
  /** Fold long strings at this width; `-1` never folds. */
  lineWidth?: number;
}

/**
 * `value` as YAML, byte for byte what js-yaml's own `dump` writes, so a
 * projection a consumer generated before with js-yaml stays unchanged.
 */
export function dump(value: unknown, options: DumpOptions = {}): string {
  return write(value, options);
}
