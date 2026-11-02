// The parts of Optique, the command-line parser library, that the `jig`
// command imports. vendor-optique.ts bundles this file from the pinned
// package into plugin/shared/vendor/optique.mjs and writes its export
// statements as that bundle's declarations; add a name here, then run
// `bun tools/plugin/vendor-optique.ts`.
export {
  argument,
  choice,
  command,
  constant,
  flag,
  formatMessage,
  map,
  message,
  multiple,
  object,
  option,
  optional,
  or,
  parse,
  runParser,
  string,
  text,
  withDefault,
} from "@optique/core";
export type {
  InferValue,
  Message,
  Parser,
  ValueParser,
  ValueParserResult,
} from "@optique/core";
