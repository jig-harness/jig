---
release: patch
---

### Fixed

- A dispatcher tick that could not identify a repository, or read its
  dispatch section (the forge read was refused, for example while a rate
  limit held it), no longer drops that
  repository's needs, queue, sessions and Ready cards from the line. The
  line keeps what the tick that last read the repository found, and its
  entry names that tick beside the newest refusal; before, a tick that
  refused every repository wrote a line with no needs at all. Ticks that
  write out of order leave the newest attempt's refusal in place.
- `jig ask --waiting` says when the line it answers from is incomplete: the
  text lists each repository whose newest read was refused, why, and when
  its part was read (or that it never was), and `--json` carries the same
  list as `incomplete`, so an empty `waiting` from an incomplete line no
  longer reads as "nothing waits on a person". The operator skill's waiting
  card relays it as a **Not read** line.
- The dashboard's answer says "Nothing needs a person in what was read" and
  names the repositories not read, rather than "Nothing needs a person",
  when a repository's newest read was refused; its banner for an old part
  gives the refusal as the reason. The tick strip marks a tick that could
  read none of the repositories it reported on as **read nothing**, and one
  that could not read some with how many were refused.
