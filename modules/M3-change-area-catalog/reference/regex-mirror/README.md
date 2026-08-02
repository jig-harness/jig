# Regex-mirror guard — keep a hand-written CI shortcut honest

Running the full change-area resolver on every CI event can be overkill when
all a workflow needs is a fast "did any *code* change?" boolean (e.g. to decide
whether to run the heavy build at all). Teams answer that with a hand-written
alternation regex over path prefixes — `^apps/|^packages/|^tools/ci/`. That
regex is a **second copy** of part of the [catalog](../catalog/), and second
copies drift: the regex says "code changed" but the resolver skips the matching
gates, or a new code path is added to an area but the shortcut still treats it
as docs-only and lets a stale marker through.

The fix is to mechanically check the regex and the catalog against each other.
The two *directional prefix* checks below (Direction 1 and Direction 2) are
necessary but not sufficient on their own: `^apps/` against a catalog that
only knows `apps/web/**` passes both, yet an unmapped file like
`apps/mobile/main.ts` is still classified as code by the regex while being
invisible to the catalog — no directional prefix comparison catches that,
because both only ever compare *prefixes*, never enumerate actual tracked
files. Closing that gap needs a third, per-tracked-file check
(`checkFilterFileCoverage`, documented in
[`../catalog/README.md#the-regex-mirror-guard`](../catalog/README.md#the-regex-mirror-guard))
alongside the two directions here. All three together prove the regex
doesn't miss a declared code-bearing glob and doesn't call an unmapped
tracked file code-bearing — not that every regex-positive file is *actually*
code-bearing (a regex alternative can still accidentally include a genuine
docs-only area's prefix; see Direction 1's gap below).

## Direction 1 — regex → catalog (runnable here: `checkFilterSegmentCoverage`)

[`check-catalog-regex-sync.sh`](check-catalog-regex-sync.sh) reads the
alternation regex out of the filter script, splits it on `|`, normalizes each
segment to a plain path prefix (strips `^`, `$`, trailing `/.*` / `/`,
backslash escapes — a trailing `/**` is rejected rather than stripped, since
unlike a catalog glob's `/**`, a regex's `/**` has engine-dependent
duplicate-quantifier semantics, not reliable "and everything under it"
meaning), and asserts each prefix is a prefix — at a path-component
boundary, never a bare substring — of the **literal head** of at least one
area's **parsed** `paths:` glob (the glob's own wildcard syntax is never
compared as literal text — see
[`../catalog/README.md#the-regex-mirror-guard`](../catalog/README.md#the-regex-mirror-guard)
for the literal-head algorithm), never a substring scan of the catalog
file's raw text. A prefix the regex knows about but no area's `paths:`
declares = drift.

```sh
FILTER_FILE=tools/ci/detect-changes-filter.sh \
CATALOG=tools/change-areas/catalog.yaml \
  ./check-catalog-regex-sync.sh
```

Inputs come from env vars so the paired self-test
([`test-catalog-regex-sync.sh`](test-catalog-regex-sync.sh)) can point the gate
at the [`fixtures/`](fixtures/): a `synced/` pair that must pass, and
adversarial pairs — most of which must fail or hard-error, though some must
still *pass* (see the `Expects` column) — see the table below for the full,
current set. Run the self-test any time with
`./test-catalog-regex-sync.sh`; wire it into your CI alongside the gate
itself, so a change that breaks the gate's own regex-handling logic fails
loudly instead of passing green.

**Why this is sound.** Each row names one specific input shape and the
behavior a real YAML/regex loader requires of it, pinned as its own
fixture and self-test case:

| Fixture | Invariant checked | Expects |
|---------|--------------------|---------|
| [`drift/`](fixtures/drift/) | a regex prefix genuinely absent from every area's `paths:` | fail |
| [`notes-only/`](fixtures/notes-only/) | the prefix appears only in a `notes:` field's prose, never in a `paths:` value | fail |
| [`boundary/`](fixtures/boundary/) | the prefix is a literal-substring near-miss of a sibling directory (`services` vs. `services-old/**`) — a component-boundary check, not a bare substring test, catches this | fail |
| [`nested-paths/`](fixtures/nested-paths/) | the prefix appears only in a reserved block's own nested `paths:` key (e.g. `ci.paths:`), not the area's own field — the parser only reads lines indented to exactly the area-field level, and a nested key always sits deeper | fail |
| [`block-scalar/`](fixtures/block-scalar/) | the prefix appears only inside a `notes: \|` block scalar's prose, which happens to contain a line shaped like a `paths:` declaration — indented deeper than the area-field level for the same reason as above | fail |
| [`empty-alternative/`](fixtures/empty-alternative/) | a regex alternative (e.g. a bare `.*`) normalizes to an empty prefix and would otherwise be silently skipped, even though the alternative it came from actually matches every path | hard error |
| [`comma-in-glob/`](fixtures/comma-in-glob/) | a literal comma inside a quoted glob (`"apps/foo,bar/**"`) is naively split on `,` into a spurious extra entry a narrower regex could falsely match | fail |
| [`inline-comment/`](fixtures/inline-comment/) | a trailing `# comment` after a `paths:` array leaks into the parsed glob, making a genuinely synced pair look like drift | pass |
| [`trailing-pipe/`](fixtures/trailing-pipe/) | a regex ending in `\|` has an empty final alternative that matches every path, but unquoted `for seg in $RE` word-splitting on `IFS='\|'` silently drops a *trailing* empty field, so a naive per-segment check never sees it | hard error |
| [`inline-comment-quoted/`](fixtures/inline-comment-quoted/) | a quoted string inside a trailing `# comment` (`paths: ["a/**"] # formerly "b/**"`) is harvested as though it were a declared glob unless the array is isolated before extracting quotes | fail |
| [`unescaped-metachar/`](fixtures/unescaped-metachar/) | an unescaped regex metacharacter (e.g. `.` in `^apps.web/`) normalizes to a plain-looking literal prefix, but the real regex matches more than that literal — must be rejected, not silently accepted as a path | hard error |
| [`escaped-dot/`](fixtures/escaped-dot/) | a backslash-escaped metacharacter (`^apps\.web/`) is a genuine literal, not a regex construct, and must stay supported | pass |
| [`bracket-glob/`](fixtures/bracket-glob/) | a catalog glob containing its own `]` (`"apps/[ab]/**"`) must be parsed whole — a naive first-`]`-wins array scan would truncate it before the closing quote | pass |
| [`unanchored-start/`](fixtures/unanchored-start/) | an alternative missing a leading `^` (`apps/`) can match anywhere in a path (`docs/apps/file`), not just its start, even though it normalizes to a prefix identical to the anchored form | hard error |
| [`unanchored-end/`](fixtures/unanchored-end/) | an alternative with no trailing `$` / `/` / `/.*` (`^apps`) is unbounded at its end and can also match an undeclared sibling like `apps-old/main.ts` | hard error |
| [`dot-star-boundary/`](fixtures/dot-star-boundary/) | a wildcard immediately after a real separator (`^apps/.*`) is a genuine path-component boundary and must stay supported | pass |
| [`escaped-pipe/`](fixtures/escaped-pipe/) | a backslash-escaped literal pipe (`^apps\|legacy/`) would be silently torn into two alternatives by the non-escape-aware `IFS='\|'` split | hard error |
| [`exact-match-descendant/`](fixtures/exact-match-descendant/) | an exact-anchored alternative (`^package$`) matches only the literal path `package`, never a descendant — a boundary-prefix match against a descendant-only glob (`package/**`) would falsely certify it as covered | fail |
| [`escaped-quote-in-glob/`](fixtures/escaped-quote-in-glob/) | a YAML-escaped quote inside a glob (`"apps/foo\"bar/**"`) would truncate the parsed value right after the backslash unless the scanner tracks escapes, not just raw quote characters | pass |
| [`directory-alt-exact-catalog/`](fixtures/directory-alt-exact-catalog/) | a directory-form alternative (`^package\.json/`) requires an actual `/` after the prefix at runtime, so it can never match a catalog value that stops exactly at the prefix (`package.json`, no descendant tree) | fail |
| [`malformed-paths-array/`](fixtures/malformed-paths-array/) | an unquoted array element (`paths: ["apps/**", services/**]`) violates the documented double-quoted-string-array schema and must hard-error, not silently narrow to the one well-formed entry found | hard error |
| [`embedded-anchor/`](fixtures/embedded-anchor/) | an unescaped `$` or `^` embedded mid-alternative (`^src/$generated/`, not the leading/trailing anchor already handled) is a regex anchor, not a literal character | hard error |
| [`trailing-garbage-after-bracket/`](fixtures/trailing-garbage-after-bracket/) | non-comment content after the array's closing `]` (`paths: ["apps/**"] garbage`) is malformed YAML and must hard-error | hard error |
| [`unsupported-yaml-escape/`](fixtures/unsupported-yaml-escape/) | a YAML escape other than `\"` / `\\` (e.g. a Unicode escape `\uXXXX`) would be mis-decoded as literal escape-sequence text rather than either correctly decoded or rejected | hard error |
| [`leading-comma/`](fixtures/leading-comma/) | a comma before the first string (`[,"apps/**"]`) is not valid YAML and must not be silently tolerated as an empty leading element | hard error |
| [`double-comma/`](fixtures/double-comma/) | two commas in a row (`["apps/**",, "services/**"]`) is not valid YAML and must not be silently tolerated as an empty middle element | hard error |
| [`empty-path-string/`](fixtures/empty-path-string/) | an empty path string (`[""]`) violates the schema's non-empty-string requirement, even when another, unrelated area declares a valid path that alone would make `PATH_GLOBS` non-empty | hard error |
| [`trailing-comma-ok/`](fixtures/trailing-comma-ok/) | a single trailing comma before `]` (`["apps/**",]`) is valid YAML and must stay supported — confirms the stricter array grammar isn't over-tight | pass |
| [`escaped-bracket-literal/`](fixtures/escaped-bracket-literal/) | a catalog glob's own bracket character class (`apps/[ab]/**`) must not be compared as literal text — its literal head is `apps/`, not `apps/[ab]/`, so an escaped-literal alternative matching the bracket text verbatim covers neither `apps/a/…` nor `apps/b/…` | fail |
| [`question-mark-variable/`](fixtures/question-mark-variable/) | a catalog glob's own `?` wildcard (`apps/web-?/**`) is exactly as variable as `[ab]` or `*` — its literal head is `apps/`, not `apps/web-?/` | fail |
| [`escaped-dollar-not-anchor/`](fixtures/escaped-dollar-not-anchor/) | a trailing `\$` is an escaped literal `$` character (matching a path ending in a real `$`), not the end-of-string anchor — treating it as the exact-anchor form would compare against the wrong catalog value | hard error |
| [`empty-paths-array/`](fixtures/empty-paths-array/) | an empty array (`paths: []`) violates the schema's ≥1-path requirement, even when another, unrelated area declares a valid path | hard error |
| [`non-array-paths/`](fixtures/non-array-paths/) | a `paths:` line that isn't the supported inline-array form (`paths: "apps/**"`, a bare string) is malformed and must hard-error, not be silently skipped | hard error |
| [`directory-alt-ancestor-of-exact/`](fixtures/directory-alt-ancestor-of-exact/) | a directory-form alternative (`^apps/`) whose prefix is a genuine strict ancestor of an exact catalog file (`apps/config.json`) must stay covered — the exact-file restriction only excludes prefix-equals-the-whole-path, not a real ancestor relationship | pass |
| [`double-star-regex-suffix/`](fixtures/double-star-regex-suffix/) | a trailing `/**` on the *regex* side (`^apps/**`) is not reliable "directory and everything under it" syntax like a catalog glob's `/**` — a real regex's `/**` has engine-dependent duplicate-quantifier semantics and can match zero `/` with nothing after, reintroducing an unbounded match | hard error |
| [`combined-suffix-slash-dollar/`](fixtures/combined-suffix-slash-dollar/) | `^apps/$` matches only the literal string `apps/` (with a trailing slash) — a different string from the bare `apps` that `^apps$` matches — but stripping both suffixes in sequence would collapse it to the same normalized prefix as a clean exact match | hard error |
| [`combined-suffix-dotstar-dollar/`](fixtures/combined-suffix-dotstar-dollar/) | `^apps/.*$` behaves exactly like the supported directory form `^apps/.*` — a `$` after a greedy `.*` adds no constraint, since `.*` already reaches the end of the string — so it must normalize and pass the same way, not be rejected as an ambiguous combined suffix | pass |
| [`combined-suffix-exact-file/`](fixtures/combined-suffix-exact-file/) | `^package\.json/$` requires a trailing slash the exact catalog file `package.json` never has, so the runtime regex can never match it, even though stripping `$` then `/` in sequence would normalize it to the same prefix as a clean exact match | hard error |
| [`unrecognized-escape/`](fixtures/unrecognized-escape/) | a backslash before an ordinary character (`\q` in `^apps\q/`) has engine-dependent, undefined-per-POSIX meaning — blindly dropping the backslash could normalize this to `appsq`, passing against a catalog declaring `appsq/**` even if the real regex covers the undeclared `apps\q/` | hard error |
| [`escaped-backslash-in-regex/`](fixtures/escaped-backslash-in-regex/) | an escaped backslash (`\\` in `^dir\\file/`) decodes to one literal `\` character, not zero — a blanket "delete every backslash" would strip both characters of the pair independently, normalizing to `dirfile` and reporting drift against a catalog that actually does declare `dir\file/**` | pass |
| [`escaped-backslash-then-dollar/`](fixtures/escaped-backslash-then-dollar/) | an escaped backslash immediately followed by a real anchor (`^dir\\$`) ends in an *even* run of backslashes before the `$`, so the `$` is unescaped and real — checking only the last two characters (`\$`) would wrongly classify it as an escaped literal `$` instead of counting the backslash run's parity | pass |
| [`whitespace-in-prefix/`](fixtures/whitespace-in-prefix/) | a literal space in the normalized prefix (`^apps/dir /`) is part of the path the runtime regex matches — trimming it as incidental whitespace would silently compare a prefix (`apps/dir`) the regex never actually produces | hard error |
| [`double-quoted-assignment/`](fixtures/double-quoted-assignment/) | a double-quoted `CODE_PATH_RE="..."` assignment does its own shell backslash processing at source time, so its raw source text isn't the runtime value this gate's own escape decoding assumes — only a single-quoted literal's raw text is guaranteed to match | hard error |
| [`brace-expansion-variable/`](fixtures/brace-expansion-variable/) | a catalog glob's own brace-expansion group (`apps/{web,api}/**`) is exactly as variable as `*`, `[ab]`, or `?` — its literal head is `apps/`, not `apps/{web,api}/` | fail |
| [`concatenated-quoted-assignment/`](fixtures/concatenated-quoted-assignment/) | two adjacent single-quoted shell words (`'^apps/''quoted/'`) concatenate to one runtime value (`^apps/quoted/`) that this gate's raw-text extraction — which has no interior-quote handling — cannot correctly read | hard error |
| [`extglob-catalog-glob/`](fixtures/extglob-catalog-glob/) | a catalog glob using bash/ksh extglob syntax (`apps/@(web)/**`) is a variable construct this implementation's literal-head scan doesn't recognize (it only scans for `*`, `[`, `?`, `{`) — reject rather than silently treat the `@(...)` group as literal text | hard error |
| [`leading-negation-glob/`](fixtures/leading-negation-glob/) | a catalog glob starting with `!` (`!apps/**`) means *exclusion* in many glob dialects (gitignore-style, micromatch's `negate`), not a literal character — reject rather than silently certify coverage of what the resolver actually excludes | hard error |
| [`escaped-metachar-in-catalog-glob/`](fixtures/escaped-metachar-in-catalog-glob/) | a backslash-escaped metacharacter in a catalog glob (`apps/literal\[name\]/**`) is a literal character, mirroring the regex side's own escape support — the literal-head scan must recognize it as escaped (not a real variable-construct trigger) and decode it, or an escaped-literal regex alternative and the catalog's own literal-head computation would disagree on what's literal | pass |
| [`multiple-assignments/`](fixtures/multiple-assignments/) | two assignments to `$CODE_PATH_RE` in one filter file — this gate never evaluates the file as shell (see the note below the table), so it can't tell which one (if either) is actually live at runtime, and rejects rather than guesses | hard error |
| [`append-assignment/`](fixtures/append-assignment/) | `CODE_PATH_RE+='\|^rogue/'` is a real mutation of the variable that a scan for only the plain `RE_VAR=` assignment form would never recognize — the `+=` line isn't blank, a comment, or the one recognized assignment, so the whole-file grammar (see the note below the table) rejects it structurally, like every other mutation form | hard error |
| [`line-continuation/`](fixtures/line-continuation/) | a backslash-newline continuation splits the variable's own name (`CODE_PATH_\` / `RE='^rogue/'`) across two physical lines — the continuation line isn't blank, a comment, or the one recognized assignment, so the file is rejected regardless | hard error |
| [`indirect-assignment/`](fixtures/indirect-assignment/) | `printf -v CODE_PATH_''RE ...` assigns the variable via a name bash builds from concatenated quoted/unquoted pieces, never appearing as one contiguous source token — the `printf` line isn't blank, a comment, or the one recognized assignment, so it's rejected the same way regardless of what it does | hard error |
| [`conditional-assignment/`](fixtures/conditional-assignment/) | an assignment wrapped in `if false; then ... fi` never actually executes, but the `if`/`fi` lines aren't blank, a comment, or the one recognized assignment, so the file is rejected without needing to reason about whether the condition is ever true | hard error |
| [`duplicate-paths-key/`](fixtures/duplicate-paths-key/) | an area's `paths:` key declared twice — most lenient YAML parsers keep only one value (commonly the last), so unioning both declarations' globs (as a naive per-line scan would) could certify a prefix the resolver can never actually see | hard error |
| [`duplicate-paths-key-comment-between/`](fixtures/duplicate-paths-key-comment-between/) | a 2-space YAML comment sitting between two `paths:` declarations in the same area doesn't end that area's mapping — the duplicate-key tracker must not treat it as a new area boundary, or the comment would let the duplicate slip through unioned | hard error |
| [`paths-outside-areas/`](fixtures/paths-outside-areas/) | a 4-space `paths:` line nested under an unrelated top-level section (not `areas:`) doesn't declare a real area's membership — the scanner only recognizes `paths:` lines genuinely inside the `areas:` block, not any line at the right indentation regardless of context | fail |
| [`paths-without-area/`](fixtures/paths-without-area/) | a `paths:` line sits at the right indentation directly inside `areas:`, but no 2-space area-name line ever opened an area for it to belong to — a handler that parses any in-block `paths:` line regardless of whether an area is currently open would still harvest its glob and falsely certify coverage | hard error |
| [`crlf-line-ending/`](fixtures/crlf-line-ending/) | a CRLF filter file's trailing `\r` is ordinary line content, not a terminator this gate strips the way it would for the real shell — a single-quoted assignment's actual runtime value keeps that `\r`, so certifying a "clean" extracted value would validate a regex that isn't the real one | hard error |
| [`duplicate-paths-key-column-zero-comment/`](fixtures/duplicate-paths-key-column-zero-comment/) | a column-zero YAML comment between two `paths:` keys in the same area doesn't end the `areas:` block at any indentation — the scanner must keep scanning past it to catch the duplicate, not stop early and see only the first key | hard error |
| [`duplicate-area-identifier/`](fixtures/duplicate-area-identifier/) | the same area identifier declared twice, each with its own `paths:` field, is the same duplicate-key hazard as a repeated field within one area — a tracker that resets per area-name line without also tracking which identifiers it's already seen would union both entries' globs instead of rejecting the repeat | hard error |
| [`duplicate-areas-key/`](fixtures/duplicate-areas-key/) | a second top-level `areas:` key re-enters the block and keeps accumulating from both mappings, though a real YAML parser retains only one — the scanner must track whether it's already seen the root key, not just whether it's currently inside one | hard error |
| [`quoted-areas-key-duplicate/`](fixtures/quoted-areas-key-duplicate/) | `"areas":` and `areas:` decode to the same YAML root key, but a scanner recognizing only the unquoted spelling would re-enter the block on the quoted line instead of rejecting it as a duplicate | hard error |
| [`spaced-areas-key-duplicate/`](fixtures/spaced-areas-key-duplicate/) | valid YAML permits separation whitespace before a key's colon (`areas :`) — a recognizer requiring the colon to immediately follow `areas` would miss this second root key as a duplicate | hard error |
| [`spaced-quoted-areas-key-duplicate/`](fixtures/spaced-quoted-areas-key-duplicate/) | the same separation-whitespace tolerance, combined with quoting (`"areas" :`) — both variations of the same root-key duplicate hazard at once | hard error |
| [`escaped-areas-key-duplicate/`](fixtures/escaped-areas-key-duplicate/) | a second top-level `areas:` key spelled with a YAML Unicode escape (`"are\u0061s":`) that a real loader decodes to the same `areas` root key — a scanner recognizing only the literal, unescaped quoted spelling never sees this line as that key at all, so it is invisible rather than flagged as a duplicate | hard error |
| [`areas-key-trailing-content/`](fixtures/areas-key-trailing-content/) | `areas: invalid` has trailing content after the colon, so it's a scalar assignment, not the nested mapping this catalog's schema requires — a recognizer checking only the key and colon would still treat the indented lines below it as the block's contents | hard error |
| [`colonless-area-line/`](fixtures/colonless-area-line/) | a 2-space-indented line with no colon at all isn't a valid `key:` mapping entry a real YAML parser would accept as declaring an area — a recognizer checking only indentation and a non-comment first character would still harvest it as an area name | hard error |
| [`area-name-trailing-content/`](fixtures/area-name-trailing-content/) | `web-app: invalid` has trailing content after the colon, so it's a scalar assignment, not the nested mapping an area declaration requires — a recognizer that finds any colon and discards everything after it, without checking what that content is, would still treat the indented `paths:` below as genuinely nested under it | hard error |
| [`anchor-prefixed-areas-key-duplicate/`](fixtures/anchor-prefixed-areas-key-duplicate/) | a second top-level `areas:` key prefixed with a YAML anchor (`&dup areas:`) — a node property that doesn't change the key's identity to a real YAML loader — falls through as an unrecognized column-zero line and silently ends the block instead of being flagged as the same duplicate-key hazard | hard error |
| [`areas-key-anchor-ok/`](fixtures/areas-key-anchor-ok/) | a single YAML anchor after the `areas:` colon (`areas: &catalog`) tags the nested mapping itself — a common, idiomatic pattern that must stay supported, not become collateral damage from rejecting the unrelated `areas: invalid` scalar-value case | pass |
| [`area-name-anchor-ok/`](fixtures/area-name-anchor-ok/) | the same single-anchor tolerance one level deeper (`web-app: &defaults`) — an area name's nested mapping can be anchored too | pass |
| [`areas-key-anchor-and-tag-ok/`](fixtures/areas-key-anchor-and-tag-ok/) | a real YAML node can carry an anchor *and* a tag together, not just one or the other (`areas: &catalog !!map`) — a recognizer tolerating only a single node-property token would reject this as though it had a disallowed scalar value | pass |
| [`areas-key-duplicate-anchor/`](fixtures/areas-key-duplicate-anchor/) | two anchors after the same colon (`areas: &catalog &second`) is not a well-formed node — a real YAML loader allows at most one anchor — so accepting any two-token combination once anchor-plus-tag is supported would wrongly let this through too | hard error |
| [`areas-key-anchor-with-hash-rejected/`](fixtures/areas-key-anchor-with-hash-rejected/) | `areas: &catalog#v1` is not valid YAML — real loaders (libyaml, Psych) reject a `#` inside an anchor name even with no preceding whitespace — so a scanner that skips past it looking for a later, genuine comment start would accept a catalog the resolver can't load | hard error |
| [`areas-key-colon-adjacent-hash-rejected/`](fixtures/areas-key-colon-adjacent-hash-rejected/) | `areas:#note` is not valid YAML — a `#` needs preceding whitespace (or start-of-line) to be recognized as a comment, so a colon immediately followed by `#` forms no valid mapping separator at all — a scanner treating any `#` right after the colon as "just a trailing comment" would accept a catalog the resolver can't load | hard error |
| [`areas-key-anchor-flow-indicator-rejected/`](fixtures/areas-key-anchor-flow-indicator-rejected/) | `areas: &catalog,` is not valid YAML — a flow indicator (`,[]{}`) can't appear in an anchor name even outside flow context; both libyaml and Psych reject it, accepting only alphanumerics, `-`, and `_` — a scanner checking only for the `&` prefix and absence of whitespace would accept a catalog the resolver can't load | hard error |
| [`areas-key-tag-flow-indicator-rejected/`](fixtures/areas-key-tag-flow-indicator-rejected/) | `areas: !tag,v1` is not valid YAML — a flow indicator (`,[]`) breaks tag scanning in libyaml just as in an anchor name (verified against the C-accelerated loader both Ruby's Psych and a properly configured PyYAML installation wrap; pure-Python PyYAML is more permissive here and isn't a reliable cross-check for this specific question) | hard error |
| [`areas-key-tag-invalid-char-rejected/`](fixtures/areas-key-tag-invalid-char-rejected/) | `areas: !tag<x>` is not valid YAML — an angle bracket (along with a quote, hash, percent, backslash, caret, backtick, brace, or pipe) breaks tag scanning in both libyaml and Psych, a narrower exclusion set than an anchor's but not "anything non-whitespace" — a scanner accepting any whitespace-free tag payload would accept a catalog the resolver can't load | hard error |
| [`area-name-comment-colon-rejected/`](fixtures/area-name-comment-colon-rejected/) | `app # pretend colon:` has no real `key:` mapping colon — the only colon on the line sits inside a trailing comment, which Psych rejects outright — a naive colon search over the whole raw line, rather than only the portion before any genuine comment, would find that comment's colon and misread the line as declaring an area named `app # pretend colon` | hard error |
| [`areas-key-non-mapping-core-tag-rejected/`](fixtures/areas-key-non-mapping-core-tag-rejected/) | `areas: !!str` is character-valid but semantically broken — `!!str` is YAML's core-schema scalar tag, and a real loader can't construct it against the indented nested mapping that follows (verified: PyYAML raises `ConstructorError`, Psych errors too) — a scanner validating only tag characters, not node-kind compatibility, would accept a catalog the resolver can't load; only `!!map` is allowed among `!!`-prefixed core tags here | hard error |
| [`multi-document-catalog-rejected/`](fixtures/multi-document-catalog-rejected/) | the real `areas:` mapping sits in a genuine *second* YAML document after a `---` separator — real content (`metadata: foo`) already appeared before it — behind an unrelated first document; a single-document loader never sees it the way a scanner would if it kept reading past the separator (Psych silently keeps only the first document; PyYAML raises outright on multi-document input) | hard error |
| [`document-end-marker-catalog-rejected/`](fixtures/document-end-marker-catalog-rejected/) | the same gap, one marker over — the real `areas:` mapping is genuine second-document content following a `...` document-end marker that already closed an unrelated first document; Psych silently keeps only the first document regardless of which marker ends it | hard error |
| [`leading-document-start-marker-ok/`](fixtures/leading-document-start-marker-ok/) | a leading `---` before any real content is an ordinary, optional single-document decoration, not a second document — this catalog is still exactly one document, loading identically with or without the marker; rejecting any `---` unconditionally would fail valid, idiomatic YAML | pass |
| [`trailing-document-end-marker-ok/`](fixtures/trailing-document-end-marker-ok/) | a trailing `...` with nothing after it is the symmetric case — an ordinary single-document terminator, not a boundary into a second document | pass |
| [`repeated-document-start-marker-rejected/`](fixtures/repeated-document-start-marker-rejected/) | two consecutive `---` markers is still a genuine second document, even with nothing of substance between them — Psych loads only the first, empty document as `nil`, discarding the real `areas:` content just as completely as if real prose had separated the two markers | hard error |
| [`document-marker-scalar-content-rejected/`](fixtures/document-marker-scalar-content-rejected/) | `--- junk` carries the marker's trailing text as real scalar content, not a bare decoration — a real loader rejects the whole document once it reaches the `areas:` mapping afterward, since a scalar document has no room for one (verified: both PyYAML and Psych) | hard error |
| [`areas-sequence-entry-rejected/`](fixtures/areas-sequence-entry-rejected/) | `  - app:` under `areas:` is a YAML block-sequence entry, not a mapping key — a real loader parses this as a sequence containing one mapping (`[{app: null, paths: [...]}]`), not the required mapping of named areas, so the resolver never sees a named `app` area to resolve against | hard error |
| [`areas-key-custom-tag-ok/`](fixtures/areas-key-custom-tag-ok/) | `areas: !unknown` is character-valid, and whether it actually resolves depends entirely on the consumer's own registered tag schema — adopter-specific policy this vendor-agnostic reference script has no way to know; deriving a rejection rule from three popular loaders' *default* behavior toward an unregistered tag isn't a property of the catalog file itself, so a character-valid custom tag stays permissive | pass |
| [`anchor-prefixed-area-name-duplicate/`](fixtures/anchor-prefixed-area-name-duplicate/) | the same anchor-prefixed duplicate-key hazard as the root `areas:` case, one level deeper — a second `app` area prefixed with a YAML anchor (`&dup app:`) decodes to the identical `app` key but isn't recognized as this gate's area-name form | hard error |
| [`anchor-prefixed-paths-key-duplicate/`](fixtures/anchor-prefixed-paths-key-duplicate/) | the same anchor-prefixed duplicate-key hazard as the root `areas:` case, at the `paths:` level — a second `paths:` key prefixed with a YAML anchor (`&dup paths:`) isn't recognized as a `paths:` declaration at all | hard error |
| [`explicit-key-areas-duplicate/`](fixtures/explicit-key-areas-duplicate/) | a second top-level `areas:` key spelled with YAML's explicit-key form (`? areas` followed by `:`) — the identical root key to a real YAML loader, but a recognizer matching only plain `key:` forms doesn't see it as that key at all | hard error |
| [`anchor-prefixed-areas-key-after-other-section/`](fixtures/anchor-prefixed-areas-key-after-other-section/) | a genuinely unrelated `metadata:` section between the first `areas:` mapping and an anchor-prefixed duplicate (`&dup areas:`) legitimately clears the scanner's block-membership flag — a check gated on that transient flag rather than the permanent fact that `areas:` has been seen at all would stop watching for the duplicate once the unrelated section appears | hard error |
| [`anchor-prefixed-areas-key-duplicate-first/`](fixtures/anchor-prefixed-areas-key-duplicate-first/) | the anchor-prefixed duplicate (`&dup areas:`) comes *before* the plain `areas:` key instead of after — a check that only starts rejecting the property-prefixed form once a plain `areas:` key has already been seen never recognizes this earlier occurrence as that key at all, and then treats the later plain key as though it were the sole declaration | hard error |
| [`explicit-key-areas-duplicate-first/`](fixtures/explicit-key-areas-duplicate-first/) | the same before-the-plain-key ordering, with the explicit-key form (`? areas`) instead of an anchor | hard error |
| [`quoted-area-identifier-duplicate/`](fixtures/quoted-area-identifier-duplicate/) | `"web-app":` and `web-app:` decode to the same YAML key, but a tracker comparing raw source text would treat them as different identifiers and union both entries' globs instead of rejecting the repeat | hard error |
| [`single-quoted-area-identifier-duplicate/`](fixtures/single-quoted-area-identifier-duplicate/) | `'web-app':` and `web-app:` decode to the same YAML key just like the double-quoted case — a tracker that only strips double quotes before comparing would miss this form | hard error |
| [`spaced-area-identifier-duplicate/`](fixtures/spaced-area-identifier-duplicate/) | a quoted area identifier with separation whitespace before the colon (`"web-app" :`) — extracting the raw text up to the first colon without trimming that trailing whitespace would leave the quote-detection check unable to recognize and strip the quotes | hard error |
| [`escaped-area-identifier-duplicate/`](fixtures/escaped-area-identifier-duplicate/) | a double-quoted area identifier using a YAML Unicode escape (`"web\u002dapp":`) that a real loader decodes to the same `web-app` a bare line elsewhere declares — stripping only the surrounding quotes without decoding (or rejecting) the escape leaves a scanner key that never matches the duplicate | hard error |
| [`escaped-quote-area-identifier-duplicate/`](fixtures/escaped-quote-area-identifier-duplicate/) | the same area identifier declared once as a plain scalar containing a literal double quote (`web"app:`) and once double-quoted with the supported `\"` escape (`"web\"app":`) — both decode to the identical YAML key, but a naive `^"[^"]*"$` outer-shape check can't see past an escaped quote, so it never even recognizes the second line as quoted | hard error |
| [`doubled-quote-area-identifier-duplicate/`](fixtures/doubled-quote-area-identifier-duplicate/) | the same area identifier declared once as a plain scalar containing a literal single quote (`web'app:`) and once single-quoted with YAML's doubled-quote escape (`'web''app':`) — both decode to the identical YAML key, but a naive `^'[^']*'$` outer-shape check can't see past a doubled quote either, so it never even recognizes the second line as quoted | hard error |
| [`spaced-paths-key/`](fixtures/spaced-paths-key/) | a `paths:` key with separation whitespace before the colon (`paths :`) is valid YAML and must still be recognized as the area's paths declaration, not silently skipped as though the area declared none | pass |
| [`quoted-paths-key-duplicate/`](fixtures/quoted-paths-key-duplicate/) | `"paths":` and `paths:` decode to the same YAML key within one area, but a scanner recognizing only the bare spelling would parse the quoted line as a second, independent declaration instead of rejecting it as a duplicate | hard error |
| [`escaped-paths-key-duplicate/`](fixtures/escaped-paths-key-duplicate/) | a second `paths:` key within one area spelled with a YAML Unicode escape (`"pa\u0074hs":`) that a real loader decodes to the same `paths` key — the same invisible-rather-than-flagged hazard as the escaped root-key case, one level deeper | hard error |
| [`area-missing-paths-middle/`](fixtures/area-missing-paths-middle/) | an area with no `paths:` key at all is a schema violation invisible to a scanner that only checks for a *second* `paths:` key within an area — masked here by a later area's glob happening to cover the regex prefix, so a per-area check (not just a whole-run union) is required | hard error |
| [`area-missing-paths-last/`](fixtures/area-missing-paths-last/) | the same missing-`paths:` violation as above, but in the file's last area — must be caught at EOF, the one boundary the per-area-transition and leave-the-block checks don't cover on their own | hard error |

**This gate never sources or evaluates `$FILTER_FILE` as shell — deliberately.**
Evaluating repository-controlled shell — the same PR this gate is meant to
be checking — would expose CI's filesystem, network, child-process, and
credential capabilities to it, well beyond what a quality gate has any
business touching. Instead, the gate requires the *entire file* to match a
minimal declarative grammar: any number of blank lines and whole-line
comments, in any order, plus exactly one line that is a plain,
single-quoted `$RE_VAR` assignment — nothing else — and reads
`$CODE_PATH_RE` by grep/sed-extracting that one line's raw source text.
This is a whitelist, not a blocklist: rather than individually recognizing
and rejecting every way shell could set or reference the variable outside
that one line (an append, a line continuation splitting its name across
physical lines, a conditional or function wrapping the assignment, an
indirect assignment built from concatenated pieces), any line that isn't
blank, a comment, or the one recognized assignment gets the file rejected
— structurally, whatever that line contains. A filter script must be
exactly "comments, blank lines, and one assignment" to be soundly checked
this way; a script that needs anything more needs some other, genuinely
sandboxed evaluation, not this reference implementation.

**Scope this reference implementation does not cover.** The `paths:` parser
handles the catalog's actual format — an inline YAML array of double-quoted
strings, `paths: ["a/**", "b/**"]`, with areas indented two spaces under
`areas:` and their own fields two more (so an area's field always sits at
exactly 4 spaces) — by string manipulation and a fixed indent width, not a
YAML parser. Left unhandled: YAML block-sequence `paths:` lists, single-quoted glob
strings, and a different indent width. Any of those needs a real YAML parser
instead of this shell recipe. The literal-head reduction's variable-construct
vocabulary is likewise bounded: `*`, `[...]`, `?`, and `{...}` — a catalog
glob using bash/ksh extglob syntax (`@(...)`, `!(...)`, `+(...)`), or a
leading `!` (gitignore-style/micromatch-style negation, a distinct dialect
feature from extglob's `!(...)`), is a hard error rather than silently
mistaken for literal text, since this implementation doesn't scan for
either; extend the scan for a resolver whose glob dialect includes them. The
scan's escape handling is also an assumption, not a detected fact: a
backslash-escaped metacharacter (`\*`, `\[`, `\]`, `\?`, `\{`, `\}`, `\\`) in
a catalog glob is decoded using the same convention as the regex side's ERE
escapes, because this implementation has no way to know which escape
convention — if any — the target resolver's glob dialect actually uses. A
resolver whose dialect disagrees (no escaping support, a different escape
character, disabled by default) needs its own decode step here. See
[`../catalog/README.md#the-regex-mirror-guard`](../catalog/README.md#the-regex-mirror-guard)
for the full four-direction spec, including `checkFilterCoverage`'s
literal-head comparison (the catalog → regex direction), which this script
does not implement.

## Direction 2 — catalog → regex (recipe)

The reverse check needs the resolver's `impliedBy` closure, so it lives with
the resolver rather than as a standalone shell script:

1. For each area, decide if it is **code-bearing** — its forward `impliedBy`
   closure reaches a [code area](../../../../GLOSSARY.md) (the *area class* you
   designate as "a change here means the heavy build must run").
2. For each code-bearing area's `paths` glob, compute its **literal head**.
   This is *not* simply "the substring before the glob's first wildcard" —
   that raw cut is unsound (a mid-component wildcard like `apps/web-*/**`
   would wrongly yield `apps/web-`, and a bracket class like `apps/[ab]/**`
   is exactly as variable as a wildcard but contributes no wildcard
   character to cut at). Follow the full algorithm in
   [`../catalog/README.md#the-regex-mirror-guard`](../catalog/README.md#the-regex-mirror-guard)'s
   `checkFilterCoverage` section exactly — it's the canonical spec; this
   recipe intentionally does not restate it, so the two can't drift apart.
3. Assert some regex alternative's normalized prefix is a path-component-
   boundary prefix of that literal head (Direction 1's comparison, run in the
   opposite direction) — **subject to the same exact-anchor restrictions
   documented in `checkFilterCoverage`**, which this recipe likewise does not
   restate (see that section for the exact rule and its ancestor-vs-equal
   distinction): an exact-anchored (`$`) alternative may only cover an
   equally wildcard-free literal head via exact string equality; a
   wildcard-free literal head (an exact file) may be covered by a
   directory-form alternative too, but only when that alternative's prefix
   is a genuine strict ancestor of it, never when the prefix would equal the
   entire exact path with nothing left over. A code-bearing glob whose
   literal head matches no alternative under these rules is drift — the
   shortcut would treat some of that area's changes as docs-only.

Wire this direction into your CI alongside Direction 1's runnable script.
Together they prove the catalog's code-bearing globs are a subset of what
the regex matches — Direction 2 proves the catalog doesn't declare a
code-bearing glob the regex misses. Direction 1 is weaker than it may sound:
it proves the regex doesn't claim a prefix *absent from the catalog
entirely*, not that every regex prefix corresponds to a *code-bearing* area
specifically — `checkFilterSegmentCoverage`'s Inputs match against every
area's `paths:`, not just code-bearing ones (see that check's Inputs in
`../catalog/README.md#the-regex-mirror-guard`). A regex alternative that
accidentally includes a genuinely docs-only area's prefix (e.g. `^docs/`,
where `docs/**` belongs to a docs-only area) passes both directions and
`checkFilterFileCoverage` — the shortcut then runs the heavy build for
docs-only changes, a correctness gap this reference implementation doesn't
close. Closing it needs a regex-positive check against the code-area class
specifically, analogous to `checkFilterCodeAreaCoverage`'s deploy-critical
check; this module doesn't yet specify one. Neither direction, alone or together,
proves every *tracked file* the regex calls code-bearing actually belongs to
some area: a regex broader than any single area's glob (`^apps/` against a
catalog that only knows `apps/web/**`) can pass both while still classifying
an unmapped file like `apps/mobile/main.ts` as code. That is what
`checkFilterFileCoverage` (see
[`../catalog/README.md#the-regex-mirror-guard`](../catalog/README.md#the-regex-mirror-guard))
catches — it is required alongside Directions 1 and 2, not an optional
refinement. Those three checks, run against the
[code area](../../../../GLOSSARY.md) class, prove the regex doesn't miss a
declared code-bearing glob and doesn't call an unmapped tracked file
code-bearing — but, per Direction 1's gap above, not that every
regex-positive file is *actually* code-bearing rather than merely declared
somewhere in the catalog. They're the checks this module specifies for a
general "did any code change?" shortcut, not a claim of completeness.

A shortcut that instead *gates a deploy* needs a fourth check,
`checkFilterCodeAreaCoverage` (same doc), which requires each tracked file's
area(s) to reach a [deploy-critical area](../../../../GLOSSARY.md) via
`impliedBy`, not merely a real one — a file can belong to a genuine,
catalog-declared area and still not be deploy-critical. This isn't simply
the three checks above *plus* a fourth: Direction 2 (`checkFilterCoverage`)
must also be run against the deploy-critical class instead of the code-area
class. Running it against the code-area class while also running
`checkFilterCodeAreaCoverage` is unsatisfiable whenever some code-bearing
area isn't deploy-critical (a CI-tooling area with `deployTier: none`, say):
Direction 2 would force the deploy-gating regex to include that area's
glob, while `checkFilterCodeAreaCoverage` would then reject every file that
glob matches. So a deploy-gating shortcut runs Direction 1 unchanged,
Direction 2 against the deploy-critical class, `checkFilterFileCoverage`
unchanged, and `checkFilterCodeAreaCoverage` — four checks, but not "the
same three plus one."

## When you don't need this

If you don't keep a hand-written CI shortcut — every job selection goes through
the resolver — there is no second copy to keep honest and this guard is
unnecessary. It exists only to make an *optimization* safe, not as a required
part of the catalog itself.
