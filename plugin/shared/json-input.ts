/** File-or-stdin JSON input for command-line decision scripts. */
import { readFile } from "node:fs/promises";

export const INVALID_JSON_INPUT = Symbol("invalid JSON input");

/** Read once, report the input failure, and distinguish it from valid JSON null. */
export async function readJsonInput(
  path: string | undefined,
  readStdin: () => Promise<string>,
): Promise<unknown> {
  let raw: string;
  try {
    raw = path === undefined ? await readStdin() : await readFile(path, "utf8");
  } catch (error) {
    console.error(
      `failed to read stdin: ${error instanceof Error ? error.message : String(error)}`,
    );
    return INVALID_JSON_INPUT;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(
      `stdin is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return INVALID_JSON_INPUT;
  }
}
