/**
 * A JSON shape, shared by a record's reader and the Protocol generator.
 * The data is JSON Schema's vocabulary; the phantom type keeps the reader's
 * TypeScript type inferred from that same declaration. Unknown fields are
 * accepted unless a contract explicitly closes its object.
 */
export type JsonSchema = boolean | { readonly [key: string]: unknown };
export interface Shape<T = unknown> {
  readonly schema: JsonSchema;
  readonly optional?: true;
  readonly _type?: T;
}
export type Infer<S extends Shape> = S extends Shape<infer T> ? T : never;
type Value<S> = S extends Shape<infer T> ? T : never;
type Fields = Readonly<Record<string, Shape>>;
type ObjectValue<P extends Fields> = {
  -readonly [K in keyof P as P[K] extends { readonly optional: true }
    ? never
    : K]: Value<P[K]>;
} & {
  -readonly [K in keyof P as P[K] extends { readonly optional: true }
    ? K
    : never]?: Value<P[K]>;
};
const shape = <T>(schema: JsonSchema): Shape<T> => ({ schema });
type Range = { minimum?: number; maximum?: number };

/** The constructors use only vocabulary the validator and generator both read. */
export const s = {
  string: (
    options: { pattern?: string; minLength?: number; maxLength?: number } = {},
  ) => shape<string>({ type: "string", ...options }),
  integer: (options: Range = {}) =>
    shape<number>({
      type: "integer",
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
      ...options,
    }),
  number: (options: Range = {}) =>
    shape<number>({ type: "number", ...options }),
  boolean: () => shape<boolean>({ type: "boolean" }),
  literal: <const T extends string | number | boolean | null>(value: T) =>
    shape<T>({ const: value }),
  enum: <const T extends readonly (string | number | boolean | null)[]>(
    values: T,
  ) => shape<T[number]>({ enum: [...values] }),
  array: <S extends Shape>(
    item: S,
    options: {
      minItems?: number;
      maxItems?: number;
      uniqueItems?: boolean;
    } = {},
  ) => shape<Value<S>[]>({ type: "array", items: item.schema, ...options }),
  object: <const P extends Fields>(
    properties: P,
    options: { additionalProperties?: boolean } = {},
  ) =>
    shape<ObjectValue<P>>({
      type: "object",
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, value.schema]),
      ),
      required: Object.entries(properties)
        .filter(([, value]) => !value.optional)
        .map(([key]) => key),
      additionalProperties: options.additionalProperties ?? true,
    }),
  optional: <S extends Shape>(value: S): S & { readonly optional: true } => ({
    ...value,
    optional: true,
  }),
  nullable: <S extends Shape>(value: S) =>
    shape<Value<S> | null>({ anyOf: [value.schema, { type: "null" }] }),
  union: <const S extends readonly Shape[]>(values: S) =>
    shape<Value<S[number]>>({ anyOf: values.map((value) => value.schema) }),
  intersection: <A extends Shape, B extends Shape>(a: A, b: B) =>
    shape<Value<A> & Value<B>>({ allOf: [a.schema, b.schema] }),
  unknown: () => shape<unknown>(true),
  never: () => shape<never>(false),
};

/** The description as draft 2020-12 schema vocabulary, without a publication address. */
export function toJsonSchema(value: Shape): JsonSchema {
  return value.schema;
}

type Constraints = Exclude<JsonSchema, boolean>;

function stringFits(schema: Constraints, value: unknown): boolean {
  return (
    typeof value === "string" &&
    (schema.minLength === undefined ||
      [...value].length >= Number(schema.minLength)) &&
    (schema.maxLength === undefined ||
      [...value].length <= Number(schema.maxLength)) &&
    (schema.pattern === undefined ||
      new RegExp(String(schema.pattern)).test(value))
  );
}

function numberFits(schema: Constraints, value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (schema.type !== "integer" || Number.isInteger(value)) &&
    (schema.minimum === undefined || value >= Number(schema.minimum)) &&
    (schema.maximum === undefined || value <= Number(schema.maximum))
  );
}

/** JSON text with object keys in sorted order, so equal values read alike. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function arrayFits(schema: Constraints, value: unknown): boolean {
  return (
    Array.isArray(value) &&
    (schema.minItems === undefined ||
      value.length >= Number(schema.minItems)) &&
    (schema.maxItems === undefined ||
      value.length <= Number(schema.maxItems)) &&
    (schema.uniqueItems !== true ||
      new Set(value.map((item) => canonicalJson(item))).size ===
        value.length) &&
    value.every((item) => fits(schema.items as JsonSchema, item))
  );
}

function objectFits(schema: Constraints, value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const fields = value as Record<string, unknown>;
  const properties = schema.properties as Record<string, JsonSchema>;
  const required = schema.required as string[];
  return (
    required.every((key) => Object.hasOwn(fields, key)) &&
    Object.entries(properties).every(
      ([key, item]) =>
        (!required.includes(key) && fields[key] === undefined) ||
        fits(item, fields[key]),
    ) &&
    (schema.additionalProperties !== false ||
      Object.keys(fields).every((key) => Object.hasOwn(properties, key)))
  );
}

/** Scalar constraints and alternatives may apply beside a document's type. */
function constraintsFit(schema: Constraints, value: unknown): boolean {
  if ("const" in schema && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (
    Array.isArray(schema.anyOf) &&
    !schema.anyOf.some((entry: JsonSchema) => fits(entry, value))
  )
    return false;
  return (
    !Array.isArray(schema.allOf) ||
    schema.allOf.every((entry: JsonSchema) => fits(entry, value))
  );
}

const validators = new Map<
  string,
  (schema: Constraints, value: unknown) => boolean
>([
  ["null", (_schema, value) => value === null],
  ["boolean", (_schema, value) => typeof value === "boolean"],
  ["string", stringFits],
  ["integer", numberFits],
  ["number", numberFits],
  ["array", arrayFits],
  ["object", objectFits],
]);

/** Validate the JSON vocabulary emitted by these constructors. */
function fits(schema: JsonSchema, value: unknown): boolean {
  if (typeof schema === "boolean") return schema;
  if (!constraintsFit(schema, value)) return false;
  const validate = validators.get(String(schema.type));
  return validate === undefined || validate(schema, value);
}

/** Whether a parsed value fits the shape; invalid input is an ordinary false. */
export function matches<S extends Shape>(
  description: S,
  value: unknown,
): value is Value<S> {
  return fits(description.schema, value);
}
