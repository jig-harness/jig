// Types for the vendored js-yaml ESM build: only the entry points the gates use.
/** A schema to load with; the core schema is JSON-compatible (no dates, binary or sets). */
export interface Schema {
  readonly __schema: unique symbol;
  /** This schema with `implicit` types added; a type with an existing tag and kind replaces it. */
  extend(types: { implicit: Type[] }): Schema;
}
/** A YAML type: how a tagged or implicitly resolved scalar becomes a value. */
export class Type {
  constructor(tag: string, options: TypeOptions);
  readonly tag: string;
  /** The options the type was built from. */
  readonly options: TypeOptions;
  construct(data: string): unknown;
}
export interface TypeOptions {
  kind: "scalar" | "sequence" | "mapping";
  construct?: (data: string) => unknown;
  [option: string]: unknown;
}
/** The built-in types the schemas are made of. */
export const types: { int: Type; float: Type };
export const CORE_SCHEMA: Schema;
/** Called as each node opens and closes. On `close`, `state.result` is the
 * node's value, `kind` what was read (null for an empty node) and `tag` its
 * explicit tag, if any; the document's root closes last. */
export type LoadListener = (
  event: "open" | "close",
  state: {
    result: unknown;
    kind: "scalar" | "sequence" | "mapping" | null;
    tag: string | null;
  },
) => void;
export function load(
  text: string,
  options?: { schema?: Schema; listener?: LoadListener },
): unknown;
