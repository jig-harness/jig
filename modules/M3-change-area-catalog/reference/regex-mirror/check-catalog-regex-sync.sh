#!/usr/bin/env bash
# Regex-mirror guard (regex -> catalog direction).
#
# When a repo keeps a fast hand-written CI regex to answer "did any code
# change?" without running the full change-area resolver, that regex is a
# second copy of part of the catalog and will drift. This gate asserts that
# every path prefix the regex matches is represented in the catalog, so a
# prefix cannot be added to the shortcut without also existing in the source
# of truth. (The reverse direction — every code-bearing catalog path is
# matched by the regex — needs the resolver's closure; see ./README.md.)
#
# How it works (checkFilterSegmentCoverage — see ../catalog/README.md#the-regex-mirror-guard):
#   1. Read the alternation regex from the filter file (a shell file assigning
#      CODE_PATH_RE='^apps/|^packages/|...').
#   2. Split it on `|` into segments (rejecting a backslash-escaped literal
#      `|`, and a leading, trailing, or doubled `|`, up front — see the
#      comments at the split site for why).
#   3. Normalize each segment to a plain path prefix: require a leading `^`
#      and a trailing boundary (an alternative unanchored at either end can
#      match more than a plain prefix comparison can certify — hard error
#      otherwise). A trailing `/**` is rejected outright (unlike a catalog
#      glob, `/**` in an actual regex has engine-dependent
#      duplicate-quantifier semantics, not reliable "directory and
#      everything under it" meaning — use `/.*` instead). For a trailing
#      `$`, classify what precedes it: an *escaped* `\$` (an odd run of
#      backslashes right before it — a leftover unpaired backslash means the
#      `$` itself is escaped, a literal character, not an anchor; an even
#      run, e.g. `^dir\\$`, pairs off completely and leaves the `$` a real
#      anchor) has no recognized boundary and is a hard error; preceded
#      by `/.*` the anchor adds no constraint beyond the already-supported
#      directory form `^apps/.*` and is stripped along with it; preceded by
#      a bare `/` the combined form is ambiguous between three different
#      runtime regexes and is rejected; anything else is a genuine
#      exact-match anchor. An alternative with no trailing `$` at all
#      instead requires a bare `/` or `/.*` boundary. Once the boundary is
#      stripped, decode backslash escapes pairwise (`\X` → `X`, only before one of the
#      recognized metacharacters below, or another backslash, in which case
#      one literal `\` survives — never a blanket "delete every backslash,"
#      which would also delete the one that's supposed to remain; a
#      backslash before an ordinary character has engine-dependent meaning
#      and is a hard error, not silently dropped) — after first
#      hard-erroring if any *unescaped* regex metacharacter (including a
#      `^` or `$` embedded mid-alternative, not just at the already-handled
#      ends) remains, since this check can only soundly represent a literal
#      path.
#   4. Parse every area's own `paths:` value out of the catalog — a line
#      indented exactly to the area-field level, never a `notes:` block
#      scalar's prose or a nested block's own `paths:` key one level deeper —
#      into a flat list of globs, requiring the array to parse as the whole
#      grammar `string (, string)* ,?` (only `\"` and `\\` are supported
#      escapes; a leading/doubled comma, an empty string, an empty `[]`
#      array, a `paths:` line that isn't an inline array at all, a `paths:`
#      key repeated within the same area, or anything but whitespace/`#`
#      after the closing `]` is a hard error) rather than silently
#      narrowing to whatever well-formed pieces it happened to find.
#   5. Reduce each parsed glob to its **literal head** — the substring up to
#      the last `/` at or before its first variable construct (`*`, `[`,
#      `?`, or `{`) — so the glob's own wildcard syntax is never compared as
#      literal text (see ../catalog/README.md#the-regex-mirror-guard for why).
#   6. Assert that prefix is a literal prefix of at least one literal head, at
#      a path-component boundary (the literal head's next character must be
#      `/` or end-of-string — `services` must not match `services-old/**`) —
#      except an exact-anchored alternative (trailing `$`), which instead
#      requires the literal head to equal the prefix exactly: `^package$`
#      matches only the literal path `package`, never a descendant like
#      `package/index.js`, so a catalog that only declares `package/**` does
#      not represent it. Any segment matching none is drift.
#
# Step 4 is why this is sound against prose: it never scans the raw catalog
# file text or a nested field, so a prefix mentioned only in a `notes:`
# field's prose, or nested under a reserved block's own `paths:` key, cannot
# satisfy the check. Only an area's real top-level `paths:` declaration can.
# Step 6's boundary check is why it is sound against near-miss prefixes: a
# literal-substring match alone would let a shorter prefix falsely match a
# longer sibling directory name. See ./README.md.
#
# Assumption: areas are indented two spaces under `areas:` and their fields
# two more (matching catalog.example.yaml) — i.e. every area's own field sits
# at exactly 4 spaces of indentation. A catalog using a different indent width
# needs its own constant here, or a real YAML parser.
#
# Assumption: the target resolver's glob dialect supports backslash-escaping
# its own metacharacters (`\*`, `\[`, `\]`, `\?`, `\{`, `\}`, `\\`) using the
# same one-backslash-per-character convention this gate's regex-side ERE
# escape decoding already uses, and that a backslash before anything else in
# a catalog glob is a literal backslash character, not an escape. Unlike the
# regex side's ERE syntax — a single well-defined standard — glob escape
# semantics vary by library and dialect: some don't support escaping a
# metacharacter at all, some use a different character, some disable it by
# default. This gate has no way to detect or configure which convention a
# given resolver actually uses, so it assumes the one above; a resolver
# whose dialect disagrees needs its own decode step here, or should avoid
# backslash-adjacent-to-metacharacter catalog globs entirely.
#
# Conventions (see ../../../M1-gates-enforcement-ladder/reference/grep-gate):
#   - exit 0 on pass; exit 1 with a formatted report on failure
#   - inputs come from env vars so the paired self-test can point at fixtures
#   - a missing filter file or catalog is a hard error (unlike a scan-tree
#     gate, there is nothing meaningful to pass when the inputs are absent)
#
# Usage:
#   check-catalog-regex-sync.sh
#   FILTER_FILE=path/to/filter.sh CATALOG=path/to/catalog.yaml check-catalog-regex-sync.sh
set -u

FILTER_FILE="${FILTER_FILE:-tools/ci/detect-changes-filter.sh}"
CATALOG="${CATALOG:-tools/change-areas/catalog.yaml}"
# Name of the variable holding the alternation regex inside FILTER_FILE.
RE_VAR="${RE_VAR:-CODE_PATH_RE}"

fail() { echo "ERROR: $*" >&2; exit 2; }

[ -f "$FILTER_FILE" ] || fail "filter file not found: $FILTER_FILE"
[ -f "$CATALOG" ]     || fail "catalog not found: $CATALOG"

# Reject a carriage return anywhere in the filter file before extracting
# anything from it. A CRLF file's trailing \r is ordinary line content to
# every text tool here, not a line terminator, so it would otherwise
# survive into the extracted value up to the point some later step (the
# trailing-whitespace strip below) silently drops it — but bash sourcing a
# single-quoted assignment does no such stripping, so the real runtime
# value keeps the \r this gate would have already normalized away.
# Rejecting outright avoids certifying a value that isn't the real one.
grep -q "$(printf '\r')" "$FILTER_FILE" && fail "$FILTER_FILE contains a carriage return (CRLF line ending) — this gate does not normalize it away, since a single-quoted assignment's real runtime value keeps a literal \\r that text processing here would otherwise silently drop"

# Read $RE_VAR by grep/sed-extracting and re-interpreting its raw source
# text — never by sourcing $FILTER_FILE, which would execute
# repository-controlled shell code (in the same PR this gate is meant to be
# checking) just to inspect one variable, well beyond what a filesystem
# check has any business doing in CI.
#
# Instead, require the *entire file* to match a minimal declarative
# grammar: any number of blank lines and whole-line comments, in any
# order, plus exactly one line that is a plain, single-quoted $RE_VAR
# assignment — nothing else. This is a whitelist, not a blocklist. Trying
# to individually recognize and reject every way shell could set or
# reference the variable outside that one line — a `+=` append, a line
# continuation splitting its name across physical lines, a conditional or
# function wrapping the assignment, an indirect assignment built from
# concatenated pieces (`printf -v` or `eval` with the name split across
# quoted and unquoted segments) — chases an unbounded list, since shell has
# no finite set of ways to construct or mutate an identifier. Requiring
# every *other* line in the file to be blank or a whole-line comment closes
# all of these the same way, structurally, without needing to recognize any
# of them individually: any line that isn't blank, a comment, or the one
# recognized assignment gets the file rejected, whatever it contains.
TOTAL_LINES=$(grep -c '' "$FILTER_FILE")
BLANK_OR_COMMENT_LINES=$(grep -cE '^[[:space:]]*(#.*)?$' "$FILTER_FILE")
OTHER_LINES=$((TOTAL_LINES - BLANK_OR_COMMENT_LINES))
[ "$OTHER_LINES" -eq 1 ] || fail "$FILTER_FILE has $OTHER_LINES non-blank, non-comment line(s), not exactly one — this gate requires the entire file to be blank lines, whole-line comments, and one plain \$$RE_VAR='...' assignment; anything else (a conditional, a function, an append, a second statement of any kind) is rejected outright, since a text scan has no sound way to know what it does without evaluating the file"
RE_LINE=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${RE_VAR}=" "$FILTER_FILE")
[ -n "$RE_LINE" ] || fail "$FILTER_FILE's one non-blank, non-comment line is not a plain assignment of the form \$$RE_VAR='...' — this gate does not evaluate the file, so it can't otherwise establish what that line does"
RE_RHS=$(printf '%s' "$RE_LINE" | sed -E 's/^[^=]*=//; s/[[:space:]]+$//')
# Require the RHS to be *exactly one* single-quoted shell word with no
# interior quote — the only form whose raw source text, extracted here
# without evaluating the file as shell, is guaranteed to equal the actual
# runtime value: single quotes do no backslash processing at assignment
# time, so what's between them is exactly the string a real
# `source "$FILTER_FILE"` would assign, *provided* there's exactly one
# quoted word. A double-quoted assignment does its own backslash processing
# first — e.g. `CODE_PATH_RE="^dir\\file/"` (two source backslashes inside
# double quotes) assigns the one-backslash string `^dir\file/` at runtime —
# so extracting the raw text between the quotes and then applying this
# gate's *own* backslash decoding below would double-decode it. A
# *concatenated* single-quoted assignment, e.g. `'^apps/''quoted/'` (two
# adjacent quoted words, valid shell for the one word `^apps/quoted/`), is
# rejected for the same underlying reason even though each half is
# individually single-quoted: this gate has no interior-quote handling, so
# it would extract the raw text `^apps/''quoted/` (the closing/opening
# quote pair still inside) rather than the real concatenated value. A
# single-quoted string can never contain a literal `'` character on its
# own — POSIX shell has no in-quote escape for it — so requiring zero
# interior quotes rejects concatenation (and any other multi-word RHS)
# without needing to parse shell word-splitting.
case "$RE_RHS" in
  \'*\')
    RE=$(printf '%s' "$RE_RHS" | sed -E "s/^'//; s/'\$//")
    case "$RE" in
      *\'*)
        fail "\$$RE_VAR in $FILTER_FILE is a concatenated or otherwise multi-word single-quoted assignment: '$RE_LINE' — this gate requires exactly one quoted word with no interior quote, since it extracts raw source text without evaluating shell word-splitting/concatenation" ;;
    esac
    ;;
  *)
    fail "\$$RE_VAR in $FILTER_FILE is not a single-quoted literal assignment: '$RE_LINE' — this gate extracts the raw source text between quotes without evaluating shell quoting, so only 'single-quoted' is sound (double-quoted or unquoted RHS can assign a different runtime value than its raw source text)" ;;
esac

[ -n "$RE" ] || fail "could not read \$$RE_VAR from $FILTER_FILE"

# Reject a backslash-escaped literal pipe before splitting: the split below is
# a raw `IFS='|'` split, not escape-aware, so `^apps\|legacy/` — meant as one
# alternative matching a literal `|` in a path — would be silently torn into
# two alternatives ('^apps\' and 'legacy/') despite the documented support for
# backslash-escaped metacharacters elsewhere in an alternative. Unsupported;
# rewrite without a literal `|` in any path.
case "$RE" in
  *'\|'*)
    fail "an escaped literal pipe (\\|) in \$$RE_VAR is not supported by this reference implementation's non-escape-aware '|' split: '$RE'" ;;
esac

# Reject a leading, trailing, or doubled `|` before splitting: unquoted `for
# seg in $RE` word-splitting on IFS='|' silently drops a *trailing* empty
# field (leading and doubled empty fields do survive and would already be
# caught by the per-segment empty-prefix check below), which would let a
# regex like '^apps/|' — whose actual empty alternative matches every path —
# check only '^apps/' and pass.
case "$RE" in
  '|'*|*'|'|*'||'*)
    fail "empty regex alternative in \$$RE_VAR: '$RE'" ;;
esac

# Parse every area's own `paths:` glob values out of the catalog — a line
# indented exactly to the area-field level (4 spaces; see the assumption
# above), which excludes both a notes: block scalar's indented prose (always
# indented deeper than its own `notes:` key) and a nested reserved block's own
# `paths:` key (also one level deeper than the area field it sits under).
# Catalog `paths:` is an inline YAML array of double-quoted strings:
# `paths: ["apps/web-app/**"]`. Scan each such line char-by-char, tracking
# quote state *and* YAML backslash escapes, and print each quoted string's
# unescaped content directly. Only `\"` (a literal `"`, not the string's
# close) and `\\` (a literal `\`) are supported escapes — this is not a full
# YAML escape decoder, so any other escape (`\n`, `\t`, a `\uXXXX` Unicode
# escape, or a plain invalid one like `\q`) is rejected outright rather than
# either mis-decoded (a `\uXXXX` copied as literal `uXXXX` text would silently
# compare against the wrong string) or silently accepted as whatever
# character follows the backslash. This one pass stops at the array's real closing `]` (only one
# *outside* a quoted string — a naive first-`]`-wins split would truncate a
# bracket-expression glob like `"apps/[ab]/**"` before its own closing quote),
# it never captures a trailing inline comment's own quoted text
# (`paths: ["x/**"] # formerly "y/**"`), and it keeps a comma inside a glob
# (`"apps/foo,bar/**"`) as one entry rather than splitting on `,`. Outside a
# quoted string, the only valid sequence is exactly `string (, string)* ,?`
# — at least one string, optionally repeated with a single comma between
# each pair, and at most one trailing comma before `]`. A leading comma, a
# doubled comma, an empty `""` value (the schema requires ≥1 char), and an
# empty `[]` array (the schema requires ≥1 path) are each rejected; after
# `]`, only whitespace or a `#` comment is allowed. A `paths:` line that
# isn't an inline array at all (e.g. a bare `paths: "apps/**"` string) is
# rejected too — matching only lines that already have the array's `[` would
# silently skip a malformed declaration in that form entirely, leaving it
# unvalidated as long as some other area's array was well-formed. A line
# that can't be verified to parse as that whole grammar — an unquoted
# token, an unterminated string, an out-of-place comma, an empty string, an
# empty array, a non-array declaration, a missing `]`, trailing non-comment
# content after `]` — must hard-error rather than silently narrow to
# whatever well-formed pieces it happened to find. A repeated `paths:` key
# within the same area — bare, single-quoted, or double-quoted, all the
# same YAML key — invalid YAML most lenient parsers nonetheless accept,
# commonly keeping only the last occurrence — is also a hard error rather
# than unioned: unioning would let a regex alternative pass by matching
# *either* declaration, even though a real YAML parser (and the
# resolver) can only ever see one of them.
#
# A 4-space `paths:` line (also tolerating whitespace before its colon,
# like every other key here) only counts at all while inside the
# top-level `areas:` block — tracked explicitly, not inferred from
# indentation alone, since a same-depth `paths:` key nested under some
# other top-level section would otherwise be harvested as if it belonged
# to an area. A column-zero comment doesn't end the block (comments don't
# affect YAML structure at any indentation, not just 2 spaces), so
# leaving the block is gated on a column-zero line that isn't a comment —
# and a second `areas:` key,
# recognized bare or in either quoting style (`areas:`, `"areas":`,
# `'areas':`, all the same YAML root key, and each tolerating YAML's
# optional whitespace before the colon), is itself a hard error (a
# duplicate top-level mapping key most lenient parsers resolve by keeping
# only one), not a second block to keep scanning. Within the block, only
# a genuine 2-space area-name line resets the per-area duplicate tracker;
# a 2-space comment must not reset it either, or a comment placed between
# two `paths:` keys would let the duplicate slip through unioned instead
# of rejected. That same area-name line's identifier — single or double
# quotes stripped, and any whitespace between the identifier and its
# colon trimmed first so a quoted, space-before-colon form (`"web-app" :`)
# still resolves to plain `web-app`, since `"web-app":`, `'web-app':`, and
# `web-app:` all decode to the same YAML key — is tracked across the
# whole block: a repeated area identifier is exactly the same
# duplicate-key hazard as a repeated `paths:` field, so two `area-name:`
# entries union both entries' `paths` values unless rejected the same way.
# Every completed area is also required to have seen exactly one `paths:`
# key by the time the next area starts, the block ends, or the file does —
# an area with none is silently invisible to every check downstream,
# exactly as invalid per the documented schema as an unrecognized array
# form, just harder to notice.
# That last check runs from END, since real EOF is one of its three
# trigger points — but awk also runs END after every mid-file `exit`, so
# every other hard-error site sets `failed` before exiting, or END would
# re-run the same check against whatever area was still open and print a
# second, unrelated error on top of the real one.
PATH_GLOBS=$(awk '
    function check_area_had_paths() {
      if (current_area != "" && !seen_paths) {
        print "malformed catalog — area " current_area " has no paths: key (line " NR "): required" > "/dev/stderr"
        failed = 1
        exit 2
      }
    }
    # A double-quoted key — whether it'"'"'s the `areas`/`paths` structural
    # keys or a 2-space area identifier — must be decoded before it'"'"'s
    # compared for duplicates: a YAML escape sequence (e.g. a Unicode
    # code-point escape, or a supported `\"` escaping a literal quote
    # inside the identifier) can spell the same key as an unescaped
    # bare or quoted line elsewhere, and comparing the raw, still-quoted
    # source text — or failing to even recognize it as quoted, since a
    # naive `^"[^"]*"$` shape check can'"'"'t see past an escaped quote
    # either — would let the duplicate slip past undetected. Only `\"`
    # and `\\` are supported, mirroring the paths: array parser below;
    # any other escape is a hard error rather than silently comparing
    # undecoded source text. `line` must start
    # exactly at the opening quote. Sets dq_key_matched (whether a
    # well-formed `"...":`  was found at all), dq_key_name (its decoded
    # text), and dq_key_after (everything following the colon,
    # unstripped of leading whitespace).
    function extract_dq_key(line,    n, i, c, nc, content, rest) {
      dq_key_matched = 0
      dq_key_name = ""
      dq_key_after = ""
      n = length(line)
      i = 2
      content = ""
      while (i <= n) {
        c = substr(line, i, 1)
        if (c == "\\") {
          if (i == n) { return }
          nc = substr(line, i + 1, 1)
          if (nc != "\"" && nc != "\\") {
            print "malformed catalog — unsupported escape sequence \\" nc " in quoted key (line " NR "): " $0 > "/dev/stderr"
            failed = 1
            exit 2
          }
          content = content nc
          i += 2
          continue
        }
        if (c == "\"") {
          rest = substr(line, i + 1)
          sub(/^[[:space:]]*/, "", rest)
          if (substr(rest, 1, 1) == ":") {
            dq_key_matched = 1
            dq_key_name = content
            dq_key_after = substr(rest, 2)
          }
          return
        }
        content = content c
        i++
      }
    }
    # A single-quoted key'"'"'s only escape is a doubled quote (two
    # single quotes decode to one literal quote character) — YAML
    # single-quoted scalars have no backslash-escape mechanism at all.
    # The naive shape check this mirrors extract_dq_key for
    # (^'"'"'[^'"'"']*'"'"'$) can'"'"'t see past a doubled quote either, for the
    # same reason the double-quoted version can'"'"'t see past \": the
    # character class disallows any interior quote, escaped or not,
    # so a doubled-quote identifier is never even recognized as
    # quoted. `line` must start exactly at the opening quote. Sets
    # sq_key_matched, sq_key_name (decoded), and sq_key_after
    # (everything following the colon, unstripped).
    function extract_sq_key(line,    n, i, c, content, rest) {
      sq_key_matched = 0
      sq_key_name = ""
      sq_key_after = ""
      n = length(line)
      i = 2
      content = ""
      while (i <= n) {
        c = substr(line, i, 1)
        if (c == "'"'"'") {
          if (i < n && substr(line, i + 1, 1) == "'"'"'") {
            content = content "'"'"'"
            i += 2
            continue
          }
          rest = substr(line, i + 1)
          sub(/^[[:space:]]*/, "", rest)
          if (substr(rest, 1, 1) == ":") {
            sq_key_matched = 1
            sq_key_name = content
            sq_key_after = substr(rest, 2)
          }
          return
        }
        content = content c
        i++
      }
    }
    # Locate the first `#` that genuinely starts a YAML comment — preceded
    # by whitespace, per YAML'"'"'s own rule — or 0 if the line has none. Used
    # before searching an unquoted area line for its `key:` mapping colon,
    # so a colon that happens to sit inside trailing comment prose
    # (`app # pretend colon:`) is never mistaken for the real separator: a
    # real YAML loader rejects that line outright (there'"'"'s no actual
    # mapping colon on it), the same as the already-handled colonless case,
    # not a legitimately-commented area declaration.
    function find_real_comment_start(line,    n, i, c) {
      n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (c == "#" && i > 1 && substr(line, i - 1, 1) ~ /[[:space:]]/) {
          return i
        }
      }
      return 0
    }
    # `areas:` or an area name (or a quoted spelling of either) with
    # anything but whitespace/`#`/one YAML anchor and/or one tag after
    # the colon isn'"'"'t opening a nested mapping at all — it'"'"'s a scalar
    # assignment (`areas: invalid`), which a real YAML parser would
    # never treat as this catalog'"'"'s nested structure. `&anchor` alone,
    # `!tag` alone, or both together in either order (`areas: &catalog
    # !!map` / `areas: !!map &catalog`) tag the nested mapping itself —
    # a real YAML node carries an anchor and a tag as two independent,
    # co-occurring properties, not a choice of one — and must stay
    # supported; anything else — a real scalar, a *second* anchor or
    # tag (only one of each is a well-formed node), an alias `*name`
    # substituting the whole value with no nested content of its own —
    # is rejected the same as any other trailing content, since this
    # scanner doesn'"'"'t resolve YAML aliases.
    function has_disallowed_trailing_content(rest,    r, hash_at, props, n, i, tok, kind, name, tagname, is_core_tag, seen) {
      # A `#` immediately following the colon, with no separating
      # whitespace, does not start a YAML comment there — YAML requires
      # whitespace (or end of line) before a `#` for it to be recognized as
      # one. `areas:#note` isn'"'"'t "areas:" plus a trailing comment to a
      # real loader; it'"'"'s a colon with no valid separator at all, which a
      # real loader rejects outright, not something that still opens a
      # nested mapping. Checked against the raw, unstripped `rest` — before
      # any leading whitespace is trimmed below — so this only fires when
      # the `#` is truly colon-adjacent, not when genuine whitespace
      # separates them.
      if (substr(rest, 1, 1) == "#") { return 1 }
      r = rest
      sub(/^[[:space:]]*/, "", r)
      if (r == "" || substr(r, 1, 1) == "#") { return 0 }
      # A `#` genuinely starts a comment only when preceded by whitespace,
      # per YAML'"'"'s own rule — but real YAML loaders (libyaml, Psych) don'"'"'t
      # accept `#` as anchor/tag *content* either way (an anchor name is
      # restricted to alphanumerics and a few punctuation characters, a
      # narrower set than the formal grammar'"'"'s "any non-flow-indicator"
      # might suggest); `&catalog#v1` fails to parse in both implementations
      # regardless of the missing space. So a `#` with no preceding
      # whitespace is never valid content in this position either — reject
      # it the same as any other disallowed trailing content, rather than
      # skip past it looking for a later, whitespace-preceded one.
      hash_at = index(r, "#")
      if (hash_at > 0) {
        if (substr(r, hash_at - 1, 1) !~ /[[:space:]]/) { return 1 }
        r = substr(r, 1, hash_at - 1)
        sub(/[[:space:]]+$/, "", r)
      }
      n = split(r, props, /[[:space:]]+/)
      if (n < 1 || n > 2) { return 1 }
      # seen is an extra (unpassed) function parameter, so awk gives it a
      # fresh, empty array on every call — no explicit reset needed, and
      # a whole-array `delete seen` isn'"'"'t POSIX-portable to begin with.
      for (i = 1; i <= n; i++) {
        tok = props[i]
        kind = substr(tok, 1, 1)
        name = substr(tok, 2)
        if (name == "") { return 1 }
        if (kind == "&") {
          # An anchor name is far narrower than "any non-flow-indicator,
          # non-whitespace character": both libyaml and Psych reject a
          # flow indicator (`,[]{}`, plus most other punctuation) in an
          # anchor even outside flow context, accepting only
          # alphanumerics, `-`, and `_` in practice. `&catalog,` — no
          # whitespace, not a `#` — would otherwise slip past as a
          # single well-formed token and let this scanner certify a
          # catalog the resolver can'"'"'t load.
          if (name !~ /^[A-Za-z0-9_-]+$/) { return 1 }
        } else if (kind == "!") {
          # Tag shorthand tolerates a broader character set than an anchor
          # (URI-ish punctuation like `-./:;=?@$&'"'"'()*+~` is fine in a tag
          # name, unlike in an anchor) but not an unrestricted one —
          # verified against libyaml directly (Python'"'"'s C-accelerated
          # CSafeLoader, the same underlying engine Ruby'"'"'s Psych wraps;
          # PyYAML'"'"'s pure-Python loader is *more* permissive here, so it'"'"'s
          # not a reliable cross-check for this specific question). A flow
          # indicator (`,[]`) breaks tag scanning too, along with a quote, hash,
          # percent, angle bracket, backslash, caret, backtick, brace, or
          # pipe — every one of those fails in libyaml regardless of
          # position. A second, immediately-following `!`
          # is the one exception: `!!` is YAML'"'"'s secondary tag handle
          # (`!!str`, `!!map`, ...), a real property, not a disallowed
          # character — stripped once before the character check so
          # `!!map` still passes, while a *third* `!` (or one elsewhere in
          # the name) means an undefined custom tag handle this scanner
          # doesn'"'"'t resolve, and is rejected the same as any other
          # disallowed character.
          #
          # A `!!`-prefixed tag also names one of the YAML core schema'"'"'s
          # *fixed* built-in types, each restricted to one node kind a real
          # loader enforces regardless of character validity: `!!str`
          # requires a scalar, so `areas: !!str` followed by an indented
          # nested mapping fails to construct (verified: PyYAML raises
          # ConstructorError "expected a scalar node, but found mapping";
          # Psych errors too). This scanner has no way to check node-kind
          # compatibility for an arbitrary core tag, so rather than accept
          # one that might not resolve, only `!!map` — the one core tag
          # this position'"'"'s nested-mapping requirement is unconditionally
          # compatible with — is allowed; every other `!!`-prefixed name is
          # rejected outright.
          #
          # An unprefixed custom tag (`!foo`), unlike a `!!`-prefixed core
          # tag, has no node kind the YAML spec fixes — whether it resolves
          # at all depends entirely on the consumer'"'"'s own registered tag
          # schema, which is adopter-specific policy this vendor-agnostic
          # reference script has no way to know. Loader-default behavior
          # toward an *unregistered* tag (js-yaml and PyYAML reject it,
          # Psych accepts it) isn'"'"'t a property of the catalog file itself —
          # a real adopter'"'"'s consumer may have that exact tag registered, or
          # may not use any of these three loaders at all — so deriving a
          # rejection rule from it would fail a correctly-configured
          # adopter'"'"'s genuinely valid catalog just as easily as it fails an
          # actually-broken one. A custom tag'"'"'s *character validity* is
          # checked the same as any tag'"'"'s (above), but whether it
          # *resolves* is explicitly out of scope here, same as this
          # scanner not tracking `%TAG` directives or resolving aliases
          # elsewhere.
          tagname = name
          is_core_tag = 0
          if (substr(tagname, 1, 1) == "!") {
            is_core_tag = 1
            tagname = substr(tagname, 2)
          }
          if (tagname == "" || tagname ~ /[][:space:]!"#%,<>[^`{|}\\]/) { return 1 }
          if (is_core_tag && tagname != "map") { return 1 }
        } else {
          return 1
        }
        if (kind in seen) { return 1 }
        seen[kind] = 1
      }
      return 0
    }
    function reject_areas_trailing_content(rest) {
      if (has_disallowed_trailing_content(rest)) {
        print "malformed catalog — areas: key has trailing content, expected a nested mapping or a YAML anchor and/or tag (line " NR "): " $0 > "/dev/stderr"
        failed = 1
        exit 2
      }
    }
    function mark_areas_key_seen() {
      if (areas_key_seen) {
        print "malformed catalog — duplicate top-level areas: key (line " NR ")" > "/dev/stderr"
        failed = 1
        exit 2
      }
      areas_key_seen = 1
      in_areas = 1
      current_area = ""
      seen_paths = 0
    }
    # A leading `---` before any real content, or a trailing `...` with
    # nothing but blank lines/comments after it, is just an optional
    # single-document decoration — legitimate, ordinary YAML that loads as
    # one document exactly like a file without either marker. What this
    # scanner can'"'"'t support is a *second* document: real content already
    # read before a `---` (a genuine second document starting), real
    # content still to come after a `...` (a genuine second document
    # following what was supposed to be the terminator), or a *second*
    # `---` even with nothing of substance between the two (Ruby'"'"'s
    # Psych.safe_load loads only the first, empty document as `nil` in
    # that case — verified directly — discarding the real areas: content
    # just as completely as if real prose had come between them; other
    # single-document loaders reject the stream outright) — either way, a
    # single-document loader never sees that second document'"'"'s `areas:`
    # the way this scanner would if it just kept reading past the boundary
    # (PyYAML'"'"'s safe_load also raises outright on multi-document input).
    # This tracks the distinction with three flags: `seen_any_content` (has
    # a real, non-blank/non-comment, non-marker line appeared yet),
    # `after_document_end` (has a `...` already been read, so any further
    # real content is a second document), and `seen_document_start` (has a
    # `---` already been consumed as the one leading marker this scanner
    # tolerates, so a second one is rejected regardless of what did or
    # didn'"'"'t come between them).
    $0 !~ /^[[:space:]]*(#.*)?$/ && $0 !~ /^(---|\.\.\.)([[:space:]]|$)/ {
      if (after_document_end) {
        print "malformed catalog — content after a ... YAML document-end marker is unsupported; this scanner only handles a single-document catalog file (line " NR "): " $0 > "/dev/stderr"
        failed = 1
        exit 2
      }
      seen_any_content = 1
    }
    /^(---|\.\.\.)([[:space:]]|$)/ {
      # A bare marker (nothing after it but optional whitespace and a
      # genuine, whitespace-preceded comment) is the only form this
      # scanner treats as a no-op decoration. `--- junk` or `... junk`
      # instead carries the marker'"'"'s trailing text as real scalar
      # content — a real loader (verified: both PyYAML and Psych) then
      # rejects the whole document once it reaches a mapping like
      # `areas:` afterward, since a scalar document has no room for one.
      # Treating any post-marker text as skippable would accept a
      # catalog the resolver can'"'"'t load.
      marker_rest = substr($0, 4)
      sub(/^[[:space:]]*/, "", marker_rest)
      if (marker_rest != "" && substr(marker_rest, 1, 1) != "#") {
        print "malformed catalog — a --- or ... marker with trailing scalar content is unsupported (line " NR "): " $0 > "/dev/stderr"
        failed = 1
        exit 2
      }
      if ($0 ~ /^\.\.\./) {
        after_document_end = 1
        next
      }
      if (seen_any_content || after_document_end || seen_document_start) {
        print "malformed catalog — a second --- YAML document-start marker is unsupported; this scanner only handles a single-document catalog file (line " NR "): " $0 > "/dev/stderr"
        failed = 1
        exit 2
      }
      seen_document_start = 1
      next
    }
    match($0, /^areas[[:space:]]*:/) || match($0, /^'"'"'areas'"'"'[[:space:]]*:/) {
      reject_areas_trailing_content(substr($0, RSTART + RLENGTH))
      mark_areas_key_seen()
      next
    }
    /^"/ {
      extract_dq_key($0)
      if (dq_key_matched && dq_key_name == "areas") {
        reject_areas_trailing_content(dq_key_after)
        mark_areas_key_seen()
        next
      }
    }
    # A line at any of this scanner'"'"'s three structurally-significant
    # positions — the root `areas:` key, a 2-space area name, or a
    # 4-space `paths:` key — that opens with a YAML node property
    # (an anchor `&name`, alias `*name`, or tag `!name`) or the
    # explicit-key indicator `?` could still decode to the identical
    # key once that prefix is resolved (`&dup areas:` is the same
    # duplicate-key hazard as `"areas":`, `? areas` followed by `:` is
    # YAML'"'"'s explicit-key form for the same key, just harder to spot
    # either way), but this scanner doesn'"'"'t parse node properties or
    # explicit keys. Rather than silently fall through to whatever
    # generic handling applies at that position — ending the areas:
    # block, or being harvested as a nonsense area/paths name — hard
    # error rather than guess. Checked unconditionally at column zero,
    # not gated on `areas_key_seen`: the hazard is symmetric in the
    # ordinary key'"'"'s position, not just after it. A property-prefixed
    # root key appearing *before* the file'"'"'s only plain `areas:` is the
    # same duplicate-key collision as one appearing after it — a real
    # YAML loader resolves both occurrences to one root key regardless
    # of which spelling came first — so this scanner can'"'"'t wait for
    # `areas_key_seen` to become true before it starts rejecting property
    # or explicit-key forms at column zero.
    /^[&*!?]/ {
      print "malformed catalog — unsupported YAML node property or explicit key (anchor/alias/tag/`?`) as a top-level key (line " NR "): " $0 > "/dev/stderr"
      failed = 1
      exit 2
    }
    in_areas && /^[^[:space:]#]/ {
      check_area_had_paths()
      in_areas = 0
    }
    !in_areas { next }
    /^ {2}[&*!?]/ {
      print "malformed catalog — unsupported YAML node property or explicit key (anchor/alias/tag/`?`) on an area declaration (line " NR "): " $0 > "/dev/stderr"
      failed = 1
      exit 2
    }
    /^ {4}[&*!?]/ {
      print "malformed catalog — unsupported YAML node property or explicit key (anchor/alias/tag/`?`) on a paths: declaration (line " NR "): " $0 > "/dev/stderr"
      failed = 1
      exit 2
    }
    /^ {2}[^ #]/ {
      check_area_had_paths()
      area_line = $0
      sub(/^ {2}/, "", area_line)
      # A `-` immediately followed by whitespace or end-of-line is YAML'"'"'s
      # block-sequence indicator, not part of a key name (`-app:` with no
      # separating space is a different, unrelated case — a plain scalar
      # starting with a literal hyphen). `areas:` followed by `  - app:`
      # doesn'"'"'t declare an area named `app` at all to a real loader — it
      # makes the areas: value a *sequence* containing one mapping
      # (`[{app: null, paths: [...]}]`), not the mapping-of-named-areas
      # this schema requires, and the resolver never sees a named `app`
      # area to resolve against. Hard error rather than harvest a bogus
      # area name out of sequence syntax this scanner doesn'"'"'t support.
      if (area_line ~ /^-([[:space:]]|$)/) {
        print "malformed catalog — areas: must be a mapping of named areas, not a sequence (line " NR "): " $0 > "/dev/stderr"
        failed = 1
        exit 2
      }
      if (substr(area_line, 1, 1) == "\"") {
        # A naive `index(area_line, ":")` colon search — like the
        # unquoted branch below uses — breaks on a double-quoted
        # identifier containing a supported `\"` escape: the outer
        # shape can'"'"'t be told apart from an unterminated string
        # without walking it escape-aware, and a colon could
        # (adversarially) sit inside the quotes too. Reuse
        # extract_dq_key, the same escape-aware scanner already used
        # for the areas:/paths: structural keys, so an escaped quote
        # doesn'"'"'t let a duplicate identifier — `web"app:` next to
        # `"web\"app":`, the identical YAML key — evade detection by
        # simply never being recognized as quoted at all.
        extract_dq_key(area_line)
        if (!dq_key_matched) {
          print "malformed catalog — area line has an unterminated or malformed double-quoted key (line " NR "): " $0 > "/dev/stderr"
          failed = 1
          exit 2
        }
        area_name = dq_key_name
        area_value = dq_key_after
      } else if (substr(area_line, 1, 1) == "'"'"'") {
        # The single-quoted mirror of the double-quoted branch above:
        # a doubled quote is just as invisible to a naive
        # (^'"'"'[^'"'"']*'"'"'$) shape check as an escaped \" is to the
        # double-quoted one, for the identical reason.
        extract_sq_key(area_line)
        if (!sq_key_matched) {
          print "malformed catalog — area line has an unterminated or malformed single-quoted key (line " NR "): " $0 > "/dev/stderr"
          failed = 1
          exit 2
        }
        area_name = sq_key_name
        area_value = sq_key_after
      } else {
        comment_at = find_real_comment_start(area_line)
        if (comment_at > 0) {
          colon_search = substr(area_line, 1, comment_at - 1)
        } else {
          colon_search = area_line
        }
        colon_pos = index(colon_search, ":")
        if (colon_pos == 0) {
          print "malformed catalog — area line has no key: mapping colon (line " NR "): " $0 > "/dev/stderr"
          failed = 1
          exit 2
        }
        area_value = substr(area_line, colon_pos + 1)
        area_name = substr(area_line, 1, colon_pos - 1)
        sub(/[[:space:]]*$/, "", area_name)
      }
      if (has_disallowed_trailing_content(area_value)) {
        print "malformed catalog — area declaration has trailing content, expected a nested mapping or a YAML anchor and/or tag (line " NR "): " $0 > "/dev/stderr"
        failed = 1
        exit 2
      }
      if (area_name in seen_areas) {
        print "malformed catalog — duplicate area identifier " area_name " (line " NR "): " $0 > "/dev/stderr"
        failed = 1
        exit 2
      }
      seen_areas[area_name] = 1
      current_area = area_name
      seen_paths = 0
    }
    function handle_paths_value(after_key,    line, n, i, c, c2, val, term, state, closed, nc, rest) {
      if (current_area == "") {
        print "malformed catalog — paths: key inside areas: but outside any area (line " NR "): " $0 > "/dev/stderr"
        failed = 1
        exit 2
      }
      if (seen_paths) {
        print "malformed catalog — duplicate paths: key within the same area (line " NR "): " $0 > "/dev/stderr"
        failed = 1
        exit 2
      }
      seen_paths = 1
      sub(/^[[:space:]]*/, "", after_key)
      if (substr(after_key, 1, 1) != "[") {
        print "malformed paths: declaration — expected an inline array starting with [, got: " after_key > "/dev/stderr"
        failed = 1
        exit 2
      }
      line = substr(after_key, 2)
      n = length(line)
      i = 1
      state = 0
      closed = 0
      while (i <= n) {
        c = substr(line, i, 1)
        if (c ~ /[[:space:]]/) { i++; continue }
        if (c == "\"" && (state == 0 || state == 2)) {
          i++
          val = ""
          term = 0
          while (i <= n) {
            c2 = substr(line, i, 1)
            if (c2 == "\\" && i < n) {
              nc = substr(line, i + 1, 1)
              if (nc != "\"" && nc != "\\") {
                print "malformed paths: array — unsupported escape sequence \\" nc " (only \\\" and \\\\ are supported)" > "/dev/stderr"
                failed = 1
                exit 2
              }
              val = val nc
              i += 2
              continue
            }
            if (c2 == "\"") { term = 1; i++; break }
            val = val c2
            i++
          }
          if (!term) { print "malformed paths: array — unterminated quoted string" > "/dev/stderr"; failed = 1; exit 2 }
          if (val == "") { print "malformed paths: array — empty path string" > "/dev/stderr"; failed = 1; exit 2 }
          print val
          state = 1
          continue
        }
        if (c == "," && state == 1) { state = 2; i++; continue }
        if (c == "]" && state == 0) {
          print "malformed paths: array — empty array (schema requires at least one path)" > "/dev/stderr"
          failed = 1
          exit 2
        }
        if (c == "]" && (state == 1 || state == 2)) { closed = 1; i++; break }
        print "malformed paths: array — unexpected character outside a quoted string: " c > "/dev/stderr"
        failed = 1
        exit 2
      }
      if (!closed) { print "malformed paths: array — missing closing ]" > "/dev/stderr"; failed = 1; exit 2 }
      rest = substr(line, i)
      gsub(/^[[:space:]]+/, "", rest)
      if (rest != "" && substr(rest, 1, 1) != "#") {
        print "malformed paths: array — unexpected content after ]: " rest > "/dev/stderr"
        failed = 1
        exit 2
      }
    }
    match($0, /^ {4}paths[[:space:]]*:/) || match($0, /^ {4}'"'"'paths'"'"'[[:space:]]*:/) {
      handle_paths_value(substr($0, RSTART + RLENGTH))
    }
    /^ {4}"/ {
      extract_dq_key(substr($0, 5))
      if (dq_key_matched && dq_key_name == "paths") {
        handle_paths_value(dq_key_after)
      }
    }
    END {
      if (in_areas && !failed) check_area_had_paths()
    }
  ' "$CATALOG")
awk_status=$?
[ "$awk_status" -eq 0 ] || fail "$CATALOG has a malformed paths: array (see stderr above) — must parse as string (, string)* ,? with no empty values, and nothing but whitespace or a # comment following the closing ]"

[ -n "$PATH_GLOBS" ] || fail "no area paths: values found in $CATALOG"

# Reject a catalog glob that looks like a bash/ksh extglob group — @(...),
# !(...), or +(...) — before literal-head reduction below, which only knows
# about the standard `*` / `[...]` / `?` / `{...}` glob dialect. An extglob
# group is exactly as variable as those (`apps/@(web)/**` matches
# `apps/web/**`, not a literal directory named `@(web)`), but this reference
# implementation doesn't scan for the `@`/`!`/`+` prefix the way it scans
# for `*`/`[`/`?`/`{`, so silently treating one as literal text would let an
# escaped-literal alternative falsely certify coverage it doesn't have —
# the same false-agreement class the literal-head reduction exists to
# close, just for a dialect this implementation doesn't recognize. Hard
# error rather than guess; a catalog using extglob globs needs its own
# extension to this scan.
case "$PATH_GLOBS" in
  *'@('*|*'!('*|*'+('*)
    fail "$CATALOG has a paths: glob using extglob syntax (@(...), !(...), or +(...)), which this reference implementation's literal-head reduction does not recognize as a variable construct — extend the scan in check-catalog-regex-sync.sh's literal-head step, or don't use extglob globs in the catalog" ;;
esac

# Reject a glob that starts with `!` — a distinct dialect feature from the
# extglob check above (this is a *leading* `!`, not `!(`). Many glob
# libraries (gitignore-style negation, micromatch/minimatch's `negate`
# option) treat a leading `!` as "exclude paths matching the rest of this
# pattern," not as a literal character. Literal-head reduction has no
# concept of exclusion, so `!apps/**` would be reduced to the literal head
# `!apps/`, letting an escaped-literal alternative `^!apps/` falsely
# certify coverage of what the real resolver treats as an *exclusion* of
# `apps/**`, not a directory literally named `!apps`. Hard error rather
# than guess whether the target dialect treats a leading `!` as negation.
if printf '%s\n' "$PATH_GLOBS" | grep -q '^!'; then
  fail "$CATALOG has a paths: glob starting with ! (leading negation), which this reference implementation's literal-head reduction treats as an ordinary literal character, not the exclusion syntax many glob dialects give it — extend the scan in check-catalog-regex-sync.sh's literal-head step for a dialect where ! means negation, or don't use a leading ! in the catalog"
fi

# Reduce each parsed glob to its literal head — the substring up to and
# including the last `/` at or before its first *unescaped* variable
# construct (`*`, `[`, `?`, or `{`; a bracket character class, a single-char
# wildcard, and a brace-expansion group each select among alternatives
# exactly as a `*` does, so all four count) — before using it in the
# boundary comparison below. Without this, a catalog value's own glob syntax
# would be compared as literal text: an escaped-literal regex alternative
# like `^apps/\[ab\]/` produces the literal prefix `apps/[ab]`, which *is* a
# literal substring of the raw catalog text `apps/[ab]/**` — but that regex
# only ever matches a directory literally named `[ab]`, while the glob
# actually matches `apps/a/**` and `apps/b/**`, neither of which contains
# that literal text. Reducing to `apps/` first (the same algorithm
# `checkFilterCoverage` uses — see ../catalog/README.md#the-regex-mirror-guard)
# means a longer prefix like `apps/[ab]` can no longer index-match a shorter
# literal head at all, so this false agreement is impossible. An ordinary
# `apps/web-app/**` trailing-wildcard glob does have a variable construct
# (the `**`) and reduces to the literal head `apps/web-app/`; only an exact,
# wildcard-free file path has no variable construct at all and is already
# its own entire literal head, unchanged by the reduction.
#
# A candidate trigger character preceded by an *odd* run of backslashes is
# itself escaped — a literal `*`/`[`/`?`/`{` character, not a variable
# construct — mirroring the regex side's own backslash-escape support
# (`^apps/\[ab\]/` already treats `\[` as literal there; the catalog side
# must recognize the equivalent, or a genuinely escaped-literal catalog
# glob like `apps/literal\[name\]/**` would be truncated at the escaped `[`
# as if it were a real bracket class, letting a broader alternative like
# `^apps/` falsely certify coverage of what the catalog actually scopes to
# the literal `literal[name]` subtree). The literal head text is decoded
# the same way afterward (`\X` -> `X`) so it compares against the regex
# side's already-decoded prefix on equal terms.
PATH_GLOBS=$(printf '%s\n' "$PATH_GLOBS" | awk '
    function decode(s,    out, i, c, n) {
      # Strip the backslash only before one of the recognized metacharacters
      # this scan treats specially (mirroring the regex side'\''s own
      # recognized-escape set). A backslash before anything else — e.g. the
      # literal `\` in a catalog value like `dir\file/**` (decoded from the
      # YAML source'\''s own `\\`, a real backslash *character* in the path,
      # not a glob-dialect escape at all) — is not a glob escape and must
      # stay exactly as-is; blindly stripping every backslash would corrupt
      # a literal backslash that just happens to precede an ordinary letter.
      out = ""
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (c == "\\" && i < length(s)) {
          n = substr(s, i + 1, 1)
          if (n == "*" || n == "[" || n == "]" || n == "?" || n == "{" || n == "}" || n == "\\") {
            out = out n
            i++
            continue
          }
        }
        out = out c
      }
      return out
    }
    {
      line = $0
      pos = 0
      for (i = 1; i <= length(line); i++) {
        c = substr(line, i, 1)
        if (c == "*" || c == "[" || c == "?" || c == "{") {
          bs = 0
          j = i - 1
          while (j >= 1 && substr(line, j, 1) == "\\") { bs++; j-- }
          if (bs % 2 == 1) continue
          pos = i
          break
        }
      }
      if (pos == 0) { print decode(line); next }
      slash = 0
      for (i = pos - 1; i >= 1; i--) {
        if (substr(line, i, 1) == "/") { slash = i; break }
      }
      # A glob whose first variable construct has no preceding `/` (e.g.
      # `**` or `*.md`) has no literal head at all: emit nothing rather
      # than an empty line. An empty head can never match a non-empty
      # prefix in the boundary comparison below, so this is still
      # fail-closed — it just avoids a blank line obscuring the report.
      if (slash > 0) { print decode(substr(line, 1, slash)) }
    }
  ')

MISSING=""
# Split the alternation on `|` and normalize each segment to a path prefix.
# set -f (noglob) so a segment containing glob metacharacters isn't
# pathname-expanded against the working directory during the split.
set -f
OLDIFS=$IFS
IFS='|'
for seg in $RE; do
  IFS=$OLDIFS
  # Require a leading `^`: an alternative not anchored to the start of the
  # path can match anywhere within a path, not just its start (`apps/` also
  # matches `docs/apps/file`), so this check cannot certify it as a prefix
  # of the path without that anchor.
  case "$seg" in
    '^'*) : ;;
    *) fail "regex alternative in \$$RE_VAR is missing a leading ^: '$seg' — an unanchored alternative can match anywhere in a path, not just its start" ;;
  esac
  after_anchor=$(printf '%s' "$seg" | sed -E 's/^\^//')
  # Reject a trailing `/**` on the *regex* side: unlike a catalog glob, where
  # `/**` is well-defined directory-tree syntax, `/**` in an actual regex is
  # just `/` followed by two adjacent `*` quantifiers — behavior POSIX ERE
  # leaves undefined for duplicate quantifiers, and permissive engines (e.g.
  # Bash's `[[ =~ ]]`) commonly collapse it to "zero or more `/`" rather than
  # "a `/` then anything." That reading means `^apps/**` can match `apps`
  # itself or even a sibling like `apps-old` (zero slashes required) with
  # nothing after — reintroducing exactly the un-anchored, boundary-free
  # false-positive risk the checks below exist to prevent. Write `/.*`
  # instead — its "zero or more of any char after a real `/`" semantics are
  # unambiguous in every regex engine.
  case "$after_anchor" in
    *'/**')
      fail "regex alternative in \$$RE_VAR ends in /** , which is not reliable regex syntax for \"this directory and everything under it\" (only a catalog glob supports /** — a real regex's /** is /, then two adjacent * quantifiers, whose behavior for duplicate quantifiers is engine-dependent and can match zero /, reintroducing an unbounded match): '$seg' — use /.* instead" ;;
  esac
  # Determine whether the alternative ends in a genuinely unescaped `$`
  # anchor, and if so, what precedes it. A trailing `$` is a real anchor
  # only when it's preceded by an *even* number of consecutive backslashes
  # (each backslash pair is one literal `\` character; a leftover unpaired
  # backslash immediately before the `$` means that `$` itself is escaped —
  # a literal `$` character, not an anchor). Checking only "does it end in
  # the two-char sequence `\$`" gets this wrong for an escaped backslash
  # immediately followed by a real anchor, e.g. `^dir\\$` — the first `\` in
  # `\\` escapes the second, leaving the `$` unescaped and real, and the
  # whole alternative matches exactly the literal path `dir\`.
  has_dollar=0
  dollar_escaped=0
  case "$after_anchor" in
    *'$')
      has_dollar=1
      bs_run="${after_anchor%'$'}"
      bs_count=0
      while [ "${bs_run: -1}" = '\' ]; do
        bs_count=$((bs_count + 1))
        bs_run="${bs_run%?}"
      done
      [ $((bs_count % 2)) -eq 1 ] && dollar_escaped=1
      ;;
  esac
  if [ "$has_dollar" -eq 1 ] && [ "$dollar_escaped" -eq 1 ]; then
    # The trailing `$` is escaped — a literal `$` character, not the
    # end-of-string anchor, even though the alternative ends in the same
    # character. An alternative ending this way has no *recognized*
    # boundary (a literal trailing character isn't `/`, `/.*`, or a real
    # `$` anchor), so it is unbounded exactly like a bare `^apps` and must
    # be rejected the same way.
    fail "regex alternative in \$$RE_VAR ends in an escaped \\\$ (a literal \$ character, not an end anchor) with no other recognized boundary: '$seg' — expected a trailing \$ (unescaped), /, or /.* so this check can certify a literal prefix"
  fi
  if [ "$has_dollar" -eq 1 ]; then
    # A real, unescaped `$` anchor. What immediately precedes it
    # distinguishes three different runtime regexes that a naive strip of
    # both a directory suffix and `$` would otherwise collapse to the same
    # prefix.
    remainder="${after_anchor%'$'}"
    case "$remainder" in
      *'/.*')
        # `^apps/.*$` behaves exactly like the supported directory form
        # `^apps/.*` — a `$` after a greedy `.*` adds no constraint, since
        # `.*` already reaches the end of the string regardless of whether
        # a `$` follows it.
        exact=0
        anchor_stripped=$(printf '%s' "$remainder" | sed -E 's/\/\.\*$//')
        ;;
      *'/')
        # `^apps/$` matches only the literal string `apps/` (with a
        # trailing slash) — a different string from both the bare `apps`
        # that `^apps$` matches and `apps/` plus anything that `^apps/.*`
        # matches. Reject rather than guess which of the three semantics a
        # combined form like this represents.
        fail "regex alternative in \$$RE_VAR combines a directory suffix with a trailing \$ anchor: '$seg' — write either a clean exact match (drop the /, keeping only \$) or a clean directory match (drop the trailing \$), not both stacked; this gate does not disambiguate combined suffix semantics" ;;
      *)
        # A genuine exact match — `^package$` matches only the single
        # literal path `package`, never anything under a descendant like
        # `package/index.js`. That's a stronger claim than the `/`, `/.*`
        # forms (which claim "this prefix plus a whole subtree"), so it
        # must be compared with exact string equality below, not the
        # boundary-prefix match those forms get: a boundary-prefix match
        # would let `^package$` falsely pass against a catalog that only
        # declares `package/**` (a descendant glob), even though no area
        # declares the bare literal path `package` itself.
        exact=1
        anchor_stripped="$remainder"
        ;;
    esac
  else
    # No `$` anchor at all: require a recognized directory boundary
    # instead. Anything else — including a bare trailing `.*` with no
    # preceding `/` — leaves the alternative's end unbounded, so `^apps` or
    # `^apps.*` would also match an undeclared sibling like
    # `apps-old/main.ts`, even though the boundary check below only ever
    # examines the *catalog* glob's boundary, never the regex's own.
    case "$after_anchor" in
      *'/'|*'/.*') : ;;
      *) fail "regex alternative in \$$RE_VAR has no path-component boundary at its end: '$seg' — expected a trailing \$, /, or /.* so this check can certify a literal prefix" ;;
    esac
    exact=0
    anchor_stripped=$(printf '%s' "$after_anchor" | sed -E 's/(\/\.\*|\/)$//')
  fi
  # Reject any *unescaped* regex metacharacter left in the alternative. This
  # gate's literal-prefix model can only soundly represent a plain path, so
  # an unescaped `.`, `[`, `]`, `(`, `)`, `{`, `}`, `+`, `?`, embedded `*`,
  # `^`, or `$` would silently make the runtime regex match more (or less)
  # than the normalized prefix claims — e.g. `^apps.web/` normalizes to the
  # literal `apps.web` and is compared as such, but the actual regex's `.`
  # also matches `appsXweb/`, a path the catalog never declares as that
  # prefix. `^` and `$` are only meaningful — and already handled — at the
  # very start and end of an alternative (stripped above); a `^` or `$`
  # still remaining here is *embedded mid-string* (e.g. `^src/$generated/`),
  # where a `$` acts as an anchor matching nothing beyond that point, not
  # the literal character its normalized-looking form suggests. A
  # backslash-escaped metacharacter (`apps\.web`) is a literal and stays
  # supported: collapse each `\`+char pair to a placeholder first so only a
  # genuinely unescaped metacharacter trips the check.
  unescaped=$(printf '%s' "$anchor_stripped" | sed -E 's/\\./X/g')
  case "$unescaped" in
    *[].[^$\(\)\{\}+?*]*)
      fail "unsupported regex metacharacter in \$$RE_VAR alternative: '$seg' (only a literal path prefix — optionally with backslash-escaped metacharacters, a leading ^, a trailing \$, and a trailing .* / / — is supported)" ;;
  esac
  # Reject a backslash followed by anything other than one of the
  # recognized metacharacters above (or `\` itself, for a literal
  # backslash). This gate treats `\X` as "X is a literal character," but
  # that's only a safe reading of an *actual* regex when X is one of the
  # characters that needed escaping to be literal in the first place — a
  # backslash before an ordinary letter like `q` has undefined-per-POSIX,
  # engine-dependent meaning (some engines drop the backslash and keep `q`;
  # others treat it as a literal `\` followed by a literal `q`). Silently
  # dropping the backslash either way — as a blanket `s/\\//g` would —
  # risks normalizing `^apps\q/` to `appsq`, passing it against a catalog
  # declaring `appsq/**` even if the real regex's runtime behavior is
  # closer to the undeclared `apps\q/`. Hard-error instead of guessing.
  case "$(printf '%s' "$anchor_stripped" | sed -E 's/\\(\.|\[|\]|\(|\)|\{|\}|\+|\?|\*|\^|\$|\\)/X/g')" in
    *'\'*)
      fail "regex alternative in \$$RE_VAR contains a backslash escape this gate does not recognize: '$seg' (a backslash is only supported before one of . [ ] ( ) { } + ? * ^ \$ \\ — its meaning before any other character is engine-dependent and not something this gate can soundly normalize)" ;;
  esac
  # Decode each `\X` escape pair to its single escaped character `X` —
  # never a blanket "delete every backslash," which mishandles `\\` (an
  # escaped backslash, meaning one literal `\` character survives in the
  # matched string): `^dir\\file/` matches `dir\file/…` at runtime, but
  # `s/\\//g` deletes *both* backslash characters independently, losing the
  # one that should remain and normalizing to `dirfile` — comparable to (and
  # passing against) an undeclared catalog value `dirfile/**` rather than
  # the actual `dir\file/**`. `s/\\(.)/\1/g` instead treats each backslash
  # together with the single character it escapes as one unit, so an
  # escaped backslash decodes to exactly one backslash, not zero.
  prefix=$(printf '%s' "$anchor_stripped" | sed -E 's/\\(.)/\1/g')
  # Do not trim surrounding whitespace: a leading or trailing space is part
  # of the literal path the runtime regex matches — `^apps/dir /` requires
  # a trailing space before the final `/` — so silently removing it would
  # compare a prefix the regex never actually produces, the same class of
  # false agreement the checks above exist to reject. Fail closed instead.
  case "$prefix" in
    [[:space:]]*|*[[:space:]])
      fail "regex alternative in \$$RE_VAR has leading or trailing whitespace in its normalized prefix: '$seg' — this gate cannot certify a prefix whose surrounding whitespace it would have to guess about" ;;
  esac
  # An alternative that normalizes to empty (a bare `.*`, or an empty
  # segment from a leading/trailing/doubled `|`) means the *actual* regex
  # matches every path — a hard error, not something to silently skip, since
  # skipping it would let the check pass while the real shortcut classifies
  # everything as code.
  [ -n "$prefix" ] || fail "empty or unsupported regex alternative in \$$RE_VAR: '$seg'"
  # Path-component-boundary prefix match against the parsed paths: values
  # only — never a substring scan of the whole catalog file, and never a bare
  # substring match that would let "services" falsely match "services-old/**".
  # The two forms require different endings on the *catalog* side, and each
  # is exclusive to its own alternative kind: an exact-anchored alternative
  # matches only when the parsed value equals the prefix exactly (rest ==
  # ""), never when the value continues with "/" — a directory-form
  # alternative (/, /.*) matches only when the value continues with "/"
  # (a real descendant subtree), never a bare rest == "" — a directory-form
  # alternative's runtime regex requires an actual "/" after the prefix, so
  # it can't match a catalog value that stops exactly at the prefix (e.g.
  # `^package\.json/` against a catalog declaring only the bare literal file
  # `package.json`, with no descendant tree to match into).
  # awk's `-v` assignment interprets C-style backslash escapes in its value
  # (e.g. `\f` becomes a form-feed character), so a `prefix` containing a
  # literal backslash (from a supported `\\` escape) must have each
  # backslash doubled before being passed this way — otherwise awk would
  # silently corrupt it, the same class of bug the decode step above exists
  # to prevent, just one step later. `n` stays the real character count of
  # the (un-doubled) `prefix`, since `substr()` counts by character, not by
  # however many backslashes awk's own literal syntax needed to see it.
  prefix_awk_safe=$(printf '%s' "$prefix" | sed 's/\\/\\\\/g')
  if ! printf '%s\n' "$PATH_GLOBS" \
      | awk -v p="$prefix_awk_safe" -v n="${#prefix}" -v exact="$exact" \
        'index($0, p) == 1 { rest = substr($0, n + 1); if ((exact && rest == "") || (!exact && substr(rest, 1, 1) == "/")) found=1 } END { exit !found }'; then
    MISSING="${MISSING}${prefix}"$'\n'
  fi
  IFS='|'
done
IFS=$OLDIFS
set +f

if [ -n "$MISSING" ]; then
  echo "ERROR: CI code-path regex has prefixes absent from the catalog"
  echo ""
  echo "Every path prefix in \$$RE_VAR ($FILTER_FILE) must be a prefix of some"
  echo "area's paths: glob in the catalog ($CATALOG) — otherwise the fast CI"
  echo "shortcut and the change-area source of truth have drifted apart. A"
  echo "prefix mentioned only in notes: or elsewhere does not count. Add the"
  echo "prefix to an area's paths, or remove it from the regex."
  echo ""
  echo "Prefixes matched by no area's paths:"
  printf '%s' "$MISSING" | sed 's/^/  /'
  exit 1
fi

echo "OK — every prefix in \$$RE_VAR is a prefix of some area's paths: in $CATALOG"
