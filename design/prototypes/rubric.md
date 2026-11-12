# Design prototype rubric

How a returned design bundle is scored before it lands. One block per bar;
a block passes or fails, and a bar not met is named in the scorecard, never
averaged away. The blocks a flow exercises are the ones its brief's
success criteria list; the rest are not scored.

## Blocks

| Block | Pass bar |
|-------|----------|
| First question | At the narrowest configured width, the page answers its persona's first question without scrolling. |
| Above the fold | At the widest configured width, the brief's above-the-fold content is visible with no horizontal scroll. |
| Keyboard | Every control and link is reachable and operable from the keyboard in document order, with visible focus. |
| Contrast | Every text pair meets WCAG 2.2 AA in both themes; every status role survives greyscale. |
| Weight | The design is buildable with the page's own stack and adds no library. |
| Truth | Nothing on the page claims a capability the backend does not have; every number on it is derived from the rows it summarizes. |
| Vocabulary | The operator vocabulary is small, its mapping from the recorded sets is stated, and every recorded name stays findable. |
| Reshaping | The information architecture changes between contrasting states, not only its badges. |
| Brand | Recognizable as the product: its tokens, its type, its plain language; no generic admin-template chrome. |
| Decisions argued | Every open decision in the brief has a written argument naming the choice, the alternatives and why they lost. |
| Neutral data | The prototype names no real organization, person, account or tracker key. |
| Scenarios | Every Tweaks scenario the brief asked for is switchable, at every configured width, in both themes. |

## What a block scores

Some blocks have a scope a bundle can read two ways, so it is stated:

- **Weight** scores the design as it would be built for production, on the
  page's own stack. A prototype that renders through its design tool's page
  runtime does not fail the block for that; the scorecard names the runtime
  dependency beside the row. The page's size in bytes is not scored.
- **Truth** scores what the page claims about the backend. A capability the
  backend does not yet have may appear in the design only when the bundle's
  handoff lists it as a server ask; the scorecard names those asks beside the
  row. A capability shown as existing that no ask covers fails the block.
- **Above the fold** scores the scenarios in which the brief's content is
  present and working. Content that stays on the page and working behind a
  banner is present, so that scenario is scored like any other. A scenario
  whose banner says the content cannot be used (the server is gone) is scored
  on the banner instead, whether the page removes that content or keeps it
  disabled or dimmed below the banner; the scorecard names the scenario and
  where the content falls.

## Scoring

The scorecard lists each block the flow exercises with `pass` or `fail`
and one line of evidence (a scenario and width, or a file). It states
exactly one `Bar outcome:` line, `pass` only when every exercised block
passes, and names the export base it reviewed.
