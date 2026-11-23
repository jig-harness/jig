/** The words a pass's route takes in a harness's own grammar: its model, then its effort, each only when set. */
export function routeWords(
  request: { model?: string | null; effort?: string | null },
  model: (value: string) => string[],
  effort: (value: string) => string[],
): string[] {
  return [
    ...(request.model == null ? [] : model(request.model)),
    ...(request.effort == null ? [] : effort(request.effort)),
  ];
}
