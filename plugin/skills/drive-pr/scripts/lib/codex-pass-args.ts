/**
 * The words a host may give a Codex pass through `drive.codex_pass_args`:
 * what `codex exec` takes between its own options and the prompt, the
 * motivating one being `--dangerously-bypass-hook-trust`, since Codex runs
 * only the hooks it has been told to trust and a pass started without a
 * terminal cannot ask. The words go after `codex exec` (after
 * `--dangerously-bypass-approvals-and-sandbox` when `drive.codex_bypass`
 * adds it) and before the prompt, so a list is refused when Codex would read
 * the drive's prompt, or a word of its own, as something else: a word that
 * is neither an option nor an option's value is the prompt to Codex (or,
 * first, a subcommand such as `exec`); an option left last without its value
 * takes the prompt as that value; `-i`/`--image` reads the words after it,
 * the prompt among them, as images; `-` reads the prompt from standard input
 * and `--` ends the options. The model is `routing.models.codex`'s, so
 * `-m`/`--model` and `-c model=…` are refused, and the bypass is
 * `drive.codex_bypass`'s, so the list cannot hold it. Option names are
 * those `codex exec --help` lists in 0.167.
 */
import { CODEX_BYPASS } from "./pass-command.ts";

/** The extra arguments a Codex pass gets when `drive.codex_pass_args` names none. */
export const DEFAULT_CODEX_PASS_ARGS: readonly string[] = [];

/**
 * One word of a Codex pass's extra arguments: no whitespace, and none of the
 * words refused wherever they stand. The audit's schema lists the same
 * pattern for the field; `refusedCodexPassArgs` refuses those and the ones
 * that depend on a word's neighbours.
 */
export const CODEX_PASS_ARG_PATTERN =
  /^(?!(?:--|-|--model|--image|--dangerously-bypass-approvals-and-sandbox)$)(?!--model=|--image=|--config=model=|-c=?model=|-m|-i)\S+$/;

/** `codex exec`'s options that need a value, but the model's and the images', which are refused outright. */
const CODEX_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--add-dir",
  "--thread-source",
  "--cyber-access-program",
  "--output-schema",
  "--color",
  "-o",
  "--output-last-message",
]);

const MODEL = "routing.models.codex or --pass-model sets a Codex pass's model";

/**
 * Why `word` cannot be a Codex pass's extra argument wherever it stands (and,
 * unless it is an option's value, why it cannot be anything but an option);
 * `undefined` when it can.
 */
function refusedWord(word: string, isValue: boolean): string | undefined {
  if (word === "--")
    return "cannot hold --: it would end the options, and the drive's prompt follows them";
  if (word === "-")
    return "cannot hold -: it reads the prompt from standard input, and the drive writes the prompt";
  if (
    word === "--model" ||
    word.startsWith("--model=") ||
    word.startsWith("-m")
  )
    return `cannot hold ${word}: ${MODEL}`;
  if (/^(?:--config=|-c=?)model=/.test(word))
    return `cannot hold ${word}: ${MODEL}`;
  if (
    word === "--image" ||
    word.startsWith("--image=") ||
    word.startsWith("-i")
  )
    return `cannot hold ${word}: it reads the words after it, the drive's prompt among them, as images`;
  if (word === CODEX_BYPASS)
    return `cannot hold ${word}: drive.codex_bypass adds it`;
  if (!isValue && !word.startsWith("-"))
    return `cannot hold ${word}: a word that is not an option or an option's value is read as the prompt (or, first, as a subcommand such as exec), and the drive writes the prompt`;
  return undefined;
}

/**
 * Why `words` cannot be extra arguments of a Codex pass, `undefined` when
 * they can (see the module header).
 */
export function refusedCodexPassArgs(
  words: readonly string[],
): string | undefined {
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string;
    const refused = refusedWord(word, false);
    if (refused !== undefined) return refused;
    if (!CODEX_VALUE_OPTIONS.has(word)) continue;
    const value = words[i + 1];
    if (value === undefined)
      return `cannot end with ${word}: it needs a value after it, and the drive's prompt would be read as that value`;
    if ((word === "-c" || word === "--config") && value.startsWith("model="))
      return `cannot hold ${word} ${value}: ${MODEL}`;
    const wrong = refusedWord(value, true);
    if (wrong !== undefined) return wrong;
    i++;
  }
  return undefined;
}

/** Why `value` cannot be `drive.codex_pass_args`, `undefined` when it can. */
export function codexPassArgsProblem(value: unknown): string | undefined {
  return Array.isArray(value) &&
    value.every((w) => typeof w === "string" && /^\S+$/.test(w))
    ? refusedCodexPassArgs(value)
    : "must be a list of words, each a string without spaces, such as [--dangerously-bypass-hook-trust]";
}
