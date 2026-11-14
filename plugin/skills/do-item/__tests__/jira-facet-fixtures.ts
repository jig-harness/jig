/** A Jira site whose project keeps type in the issue types and size in a custom field, for the facet tests. */
import { JIG_TAXONOMY } from "./github-fixtures.ts";
import { type Overlay, page } from "./jira-fixtures.ts";

/** The site's fields, as `GET field` returns them. */
const SITE_FIELDS = [
  { id: "summary", name: "Summary", schema: { type: "string" } },
  { id: "customfield_10016", name: "Story Points", schema: { type: "number" } },
  { id: "customfield_10050", name: "Size", schema: { type: "option" } },
  { id: "customfield_10051", name: "Team", schema: { type: "option" } },
  { id: "customfield_10052", name: "Team", schema: { type: "option" } },
  {
    id: "customfield_10060",
    name: "Notes",
    schema: {
      type: "string",
      custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea",
    },
  },
];

/** The project's issue types, as `GET issue/createmeta/ENG/issuetypes` returns them. */
const TYPES = {
  issueTypes: [
    ["t0", "Epic", false, 1],
    ["t1", "Bug", false, 0],
    ["t2", "Story", false, 0],
    ["t3", "Task", false, 0],
    ["t4", "Sub-task", true, -1],
  ].map(([id, name, subtask, hierarchyLevel]) => ({
    id,
    name,
    subtask,
    hierarchyLevel,
  })),
  startAt: 0,
  maxResults: 100,
  total: 5,
};

export const SIZE_OPTIONS = ["XS", "S", "M", "L", "XL"].map((value, i) => ({
  id: `o${i}`,
  value,
}));

/** A create screen holding the Size field with its options. */
export const SCREEN = {
  fields: [
    { fieldId: "customfield_10050", allowedValues: SIZE_OPTIONS },
    {
      fieldId: "priority",
      allowedValues: ["Highest", "High", "Medium", "Low"].map((name, i) => ({
        id: String(i + 1),
        name,
      })),
    },
  ],
  startAt: 0,
  maxResults: 100,
  isLast: true,
};

export const PRIORITIES = {
  values: ["Highest", "High", "Medium", "Low"].map((name, i) => ({
    id: String(i + 1),
    name,
  })),
  startAt: 0,
  maxResults: 100,
  isLast: true,
};

/** Type in the issue types (feature is a Story), size in the Size field. */
export const STORES: Overlay = {
  issue_tracker: {
    facets: {
      type: { store: "native", values: { feature: "Story" } },
      size: {
        store: "field",
        field: "Size",
        values: { xs: "XS", small: "S", medium: "M", large: "L", xl: "XL" },
      },
    },
  },
  taxonomy: JIG_TAXONOMY,
};

/** Every create screen and the site's lists the stores read. */
export const SITE = {
  "GET field": SITE_FIELDS,
  "GET issue/createmeta/ENG/issuetypes": TYPES,
  "GET issue/createmeta/ENG/issuetypes/t1": SCREEN,
  "GET issue/createmeta/ENG/issuetypes/t2": SCREEN,
  "GET issue/createmeta/ENG/issuetypes/t3": SCREEN,
  "GET issue/createmeta/ENG/issuetypes/t4": SCREEN,
  "GET priority/search": PRIORITIES,
  "POST search/jql": page(),
};
