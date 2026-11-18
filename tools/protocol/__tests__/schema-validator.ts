/** Independent draft 2020-12 validation for the Protocol's generated schemas. */
import { expect } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";

/** Compile the published schema, including strict checks on the schema itself. */
export function schemaValidator(schema: object | boolean) {
  const validator = new Ajv2020({ allErrors: true, strict: true });
  return validator.compile(schema);
}

/** A writer's JSON must fit the independently compiled published schema. */
export function expectSchemaAccepts(schema: object | boolean, value: unknown) {
  const validate = schemaValidator(schema);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

/** A malformed record must also be refused by a reader in another language. */
export function expectSchemaRejects(schema: object | boolean, value: unknown) {
  expect(schemaValidator(schema)(value)).toBe(false);
}
