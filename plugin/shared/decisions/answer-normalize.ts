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

/** Both names of the dispatcher's hold option match while earlier decisions stay open. */
export function normalizeOptionName(text: string): string {
  const normalized = normalizeAnswerText(text);
  return normalized === "leave it to me"
    ? normalizeAnswerText("I'll handle it — hide this card")
    : normalized;
}
