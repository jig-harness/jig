# Rule matchers in configuration

Version 1 · stable

Some settings in a repository's `.config/jig.yaml` choose something by
what a tracker item or a change holds: the base branch a pull request
targets by the item's labels, the review gates a change owes by its labels
or the paths it touches, the agent that implements it by its labels or its
title, whether a raise moves the implementer's effort by its size. Each such
setting is a list of **rules**, and one **rule matcher** in the plugin
decides every one of them the same way. This chapter is for the person who
writes such a setting, and for a program outside Jig's skills that wants to
evaluate a rule the way Jig does: which facts a rule may test, how each is
compared, how a rule's values combine, and how a setting's rules resolve.

A rule maps facts to the values it lists:

```yaml
pull_requests:
  base_rules:
    - when: { labels: [hotfix, urgent] }
      base: release
```

Most settings are written in a shorter form that stands for such a rule (a
list of labels, a map from a label to a result); the table of forms below
says how each reads. A rule naming a fact this chapter does not list, a fact
its setting does not test, or a value of the wrong kind, is a configuration
error: the shared configuration reader refuses the whole configuration,
naming the setting and the file that set it, before any skill acts on it,
and the audit reports it. A program reading a rule written for a later
version of this chapter, with a fact it does not know, treats the rule as
one it cannot evaluate, never as one that matches nothing.

When a skill says why it chose something (the base `pr-plan.ts` prints, a
reason in a route `determine_route.ts` prints, a gate `determine_agent.ts`
applies), it names the setting, the rule and what matched in one wording:
`pull_requests.base_rules[0], for the item's label hotfix`.

Each setting's default and what it is for:
[the configuration reference](../CONFIGURATION.md). The same values, for a
program in any language: [data/rule-matchers.json](data/rule-matchers.json);
the shape of a rule as `when` holds it: [schemas/rule.json](schemas/rule.json).

## The facts a rule may test

A rule's facts are tried in this order, and a rule's values for one fact in
the order written; the first value that matches one of the item's values is
the one a reason names.

<!-- protocol:generated source=plugin/shared/rule-matcher-values.ts#FACTS -->

| Fact | The item holds | A rule lists | Compared | Meaning |
| --- | --- | --- | --- | --- |
| `labels` | a list of label names | a list of label names | Equal, ignoring case and white space around the name: `Bug` matches `bug`. | The labels the tracker item carries; for a flag an area of the change-area catalog declares, the flags of the areas the item's labels reach. |
| `title` | one text | a list of keywords | The keyword appears anywhere in the title, ignoring case: `migration` matches `Write the Migrations`. | The tracker item's title. |
| `size` | a list of size names | a list of size names | Equal, ignoring case and white space around the name, as a label is; a size is never compared by its step, so `large` does not match `L`. | The item's size: its size facet's value where the repository has a size facet, else its labels. |
| `paths` | a list of repository-relative paths | a list of path globs | The glob claims the path, by the glob matching the change-area catalog uses: `**` spans directories, `*` and `?` stay within one, `{a,b}` alternates and `[...]` is a character class. | The paths the change touches. Before the change exists they are the paths the caller says it plans to touch; a rule that could match only by its paths is then listed apart, for whoever plans the change to apply. |

<!-- /protocol:generated -->

## How a rule combines its values

<!-- protocol:generated source=plugin/shared/rule-matcher-values.ts#COMBINATION -->

| Combination | Meaning |
| --- | --- |
| `any` | A rule matches when any one value it lists, for any one fact it tests, matches the item: one label of several is enough, and a label or a path is enough. A rule cannot yet say that every value, or none, must match. |

<!-- /protocol:generated -->

## How a setting's rules resolve

<!-- protocol:generated source=plugin/shared/rule-matcher-values.ts#LIST_SEMANTICS -->

| List semantics | Meaning |
| --- | --- |
| `first` | The rules are tried in the order written and the first that matches decides; when none matches, the field's fallback applies. |
| `every` | Every rule that matches applies, in the order written. |
| `lookup` | A map from one fact's value to a result: every key that matches one of the item's values applies, in the order of the item's values, then the order written. Keys that differ only in case are one key, the last written. |
| `one` | The field is one rule: it applies or not, and names the value that matched. |

<!-- /protocol:generated -->

## How a setting is written

<!-- protocol:generated source=plugin/shared/rule-matcher-values.ts#RULE_FORMS -->

| Form | Meaning |
| --- | --- |
| `when` | A list of entries, each holding its rule under `when`: `{ when: { labels: [hotfix] }, base: release }`. |
| `entry` | A list of entries whose own fact keys are the rule: `{ labels: [db], paths: ["db/**"], skill: migration-review }`. |
| `map` | A map from a value of the field's fact to a result: `{ bug: kind/bug }` is the rule `{ labels: [bug] }` for the result `kind/bug`. |
| `list` | A list of values of the field's fact: `[has-migration]` is the rule `{ labels: [has-migration] }`. |

<!-- /protocol:generated -->

## The settings that use the matcher

<!-- protocol:generated source=plugin/shared/rule-matcher-values.ts#RULE_FIELDS -->

| Field | Facts | List | Form | Words | Read by | Meaning |
| --- | --- | --- | --- | --- | --- | --- |
| `pull_requests.base_rules` | labels | `first` | `when` | — | do-item, audit | The base branch a pull request targets: the first rule's `base`; the integration branch when none matches. |
| `do_item.gates` | labels, paths | `every` | `entry` | — | do-item | The review skills that must approve a change before it is pushed. |
| `do_item.guidance` | labels, paths | `every` | `entry` | — | do-item, audit | The skills and notes the implementing agent is given. |
| `do_item.agents.labels` | labels | `lookup` | `map` | — | do-item, work-batch | The agent that implements an item carrying the label. |
| `do_item.agents.codearea_areas` | labels | `lookup` | `map` | — | do-item, work-batch | The change area an item carrying the label reaches, for the area's agent and guidance. |
| `do_item.agents.title_keywords` | title | `lookup` | `map` | — | do-item | The agent that implements an item whose title holds the keyword, beside the agents its labels choose. |
| `pull_requests.labels_from_issue` | labels | `lookup` | `map` | — | do-item, audit | The label the pull request opens with for an item carrying the label. |
| `pull_requests.reviewers_from_issue` | labels | `lookup` | `map` | — | do-item | The reviewers asked on the pull request for an item carrying the label. |
| `routing.complex_flags` | labels | `one` | `list` | — | do-item, audit | Makes the item's complexity tier complex at any size, when the item or an area it reaches carries one of the flags. |
| `routing.raise.flags` | labels | `one` | `list` | catalog: Every flag an area of the change-area catalog declares. | do-item, audit | Raises the implementer's effort one step. |
| `routing.raise.sizes` | size | `one` | `list` | — | do-item, audit | Raises the implementer's effort one step; unset, the sizes `issue_tracker.labels.batch_sizes` leaves out. |
| `work_batch.solo_flags` | labels | `one` | `list` | — | work-batch | Holds an item out of a batch, joined to the flags work-batch derives (the human-in-the-loop label and its facets, `manual-ops`, and every flag the catalog declares). |

<!-- /protocol:generated -->
