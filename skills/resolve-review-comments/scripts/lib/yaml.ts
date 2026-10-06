/** Preserve the operated YAML parser behind a typed packaging boundary. */
import { load as parse } from "js-yaml";

export function load(text: string): unknown {
  return parse(text);
}
