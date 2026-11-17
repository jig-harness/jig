/** One step of normalizing an answer's text, with what it does to a reader. */
export interface NormalizationStep {
  readonly meaning: string;
  readonly apply: (text: string) => string;
}

/**
 * How a person's answer and an option's name are normalized before they are
 * compared, step by step in this order, so a phone's typography still
 * matches: the same spelling rules apply to both.
 */
export const ANSWER_NORMALIZATION = {
  compatibility: {
    meaning:
      "Applies Unicode's compatibility normalization (NFKC): full-width letters and other compatibility forms become their plain forms.",
    apply: (text) => text.normalize("NFKC"),
  },
  case: {
    meaning: "Folds every letter to lower case.",
    apply: (text) => text.toLowerCase(),
  },
  quotes: {
    meaning:
      "Turns typographic single quotes (U+2018 to U+201B) into `'` and double quotes (U+201C to U+201F) into `\"`.",
    apply: (text) =>
      text.replace(/[\u2018-\u201b]/g, "'").replace(/[\u201c-\u201f]/g, '"'),
  },
  dashes: {
    meaning:
      "Turns hyphens and dashes (U+2010 to U+2015) and the minus sign (U+2212) into `-`.",
    apply: (text) => text.replace(/[\u2010-\u2015\u2212]/g, "-"),
  },
  marks: {
    meaning:
      "Removes backticks and the bold marks `**` and `__`, which a pasted or formatted answer may carry.",
    apply: (text) => text.replace(/`|\*\*|__/g, ""),
  },
  "white-space": {
    meaning:
      "Reads every run of white space as one space, and drops white space at either end.",
    apply: (text) => text.replace(/\s+/g, " ").trim(),
  },
  "final-stop": {
    meaning:
      "Drops one full stop or exclamation mark at the end, which a phone's keyboard may add, and the space before it.",
    apply: (text) => text.replace(/[.!]$/, "").trimEnd(),
  },
} as const satisfies Readonly<Record<string, NormalizationStep>>;

const STEPS: readonly NormalizationStep[] = Object.values(ANSWER_NORMALIZATION);

/** The same spelling rules apply to a person's answer and an option's name. */
export function normalizeAnswerText(text: string): string {
  return STEPS.reduce((normalized, step) => step.apply(normalized), text);
}

/** Whether `answer` names `option`, optionally including the dispatcher's retired hold spelling. */
export function optionNameMatches(
  option: { id?: string; name: string },
  answer: string,
  allowRetiredHoldAlias = false,
): boolean {
  const normalized = normalizeAnswerText(answer);
  return (
    normalizeAnswerText(option.name) === normalized ||
    (allowRetiredHoldAlias &&
      option.id === "hold" &&
      ((option.name === "I'll handle it — hide this card" &&
        normalized === "leave it to me") ||
        (option.name === "Leave it to me" &&
          normalized ===
            normalizeAnswerText("I'll handle it — hide this card"))))
  );
}
