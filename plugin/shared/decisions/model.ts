/** The option and call shared by decision sheets and parked decisions. */
export interface Option {
  /** One to eight letters or digits within its call. */
  id: string;
  name: string;
  tag?: string;
  summary: string;
  pay: string[];
  keep?: string[];
  rightWhen?: string;
  obligation?: string;
}

export interface Call<O extends Option = Option> {
  id: string;
  question?: string;
  options: O[];
  recommended?: string;
  why?: string;
}

export interface OptionDetail {
  label: string;
  text: string;
}

/** Field order and labels for readers that show optional details as text. */
const OPTION_DETAILS = [
  { field: "tag", label: "Tag" },
  { field: "keep", label: "Keep" },
  { field: "rightWhen", label: "Right when" },
  { field: "obligation", label: "Obligation" },
  { field: "reversible", label: "Reversible" },
] as const;

export function optionDetails(
  option: Option & { reversible?: boolean },
): OptionDetail[] {
  return OPTION_DETAILS.flatMap(({ field, label }) => {
    const value = option[field];
    if (value === undefined) return [];
    const text =
      typeof value === "boolean"
        ? value
          ? "Yes"
          : "No"
        : Array.isArray(value)
          ? value.join("\n")
          : value;
    return text.length === 0 ? [] : [{ label, text }];
  });
}
