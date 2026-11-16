/** The same spelling rules apply to a person's answer and an option's name. */
export function normalizeAnswerText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/`|\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]$/, "")
    .trimEnd();
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
