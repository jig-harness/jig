/** The line an issue body carries when a skill filed it without asking. */
export function filedByLine(skill: string, pr: string, why: string): string {
  return `Filed by \`/jig:${skill}\` from ${pr}, without a person's confirmation: ${why}`;
}
