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
| Weight | The design is drawable as one HTML document with inline vector graphics and stylesheets; it needs no run-time library to render. |
| Truth | Nothing on the page claims a capability the backend does not have; every number on it is derived from the rows it summarizes. |
| Vocabulary | The operator vocabulary is small, its mapping from the recorded sets is stated, and every recorded name stays findable. |
| Reshaping | The information architecture changes between contrasting states, not only its badges. |
| Brand | Recognizable as the product: its tokens, its type, its plain language; no generic admin-template chrome. |
| Decisions argued | Every open decision in the brief has a written argument naming the choice, the alternatives and why they lost. |
| Neutral data | The prototype names no real organization, person, account or tracker key. |
| Scenarios | Every Tweaks scenario the brief asked for is switchable, at every configured width, in both themes. |

## Scoring

The scorecard lists each block the flow exercises with `pass` or `fail`
and one line of evidence (a scenario and width, or a file). It states
exactly one `Bar outcome:` line, `pass` only when every exercised block
passes, and names the export base it reviewed.
