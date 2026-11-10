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
