# Governance

Who decides what about Jig, and how a decision is made. The rules a change
must keep are in [AGENTS.md](AGENTS.md); how a change is made is in
[CONTRIBUTING.md](CONTRIBUTING.md). This page says who has the last word.

## One maintainer decides

Jig has one maintainer. The maintainer decides what goes into Jig, what a
module states, what the plugin ships and when, and what this page says.
Discussion is sought on every change that is not routine, in the issue or
pull request that carries it, and a decision that goes against a
contributor's view says why. Agreement is welcome; it is not required. A
decision that will hold for a long time is recorded as a
[decision record](docs/adr/) so that the next person, or the next agent
session, finds it.

Agents write most of Jig's changes and drive most of its reviews. They do
not decide: every pull request to Jig is merged by a person
([ADR-0003](docs/adr/ADR-0003-a-person-merges.md)), and the decisions below
stay with a person whatever an agent proposes.

## What stays with a person

Publishing and visibility, the licence, deleting seed material, anything
that touches the no-origin-references rule, a loosening of a gate, and any
change to this page. An agent that reaches one of these stops and asks
([AGENTS.md](AGENTS.md)).

## How something gets in

[CONTRIBUTING.md § Outside contributions](CONTRIBUTING.md#outside-contributions)
says which contributions are welcome as a pull request, which need an
issue first, and which are not taken. In short: Jig states general
patterns and keeps one organization's values out of them, so a
contribution that generalizes a practice, adds a mapping for another
ecosystem, or fixes something with a test is welcome, and one that brings
in an organization's material or an unproven practice is not.

Much of what a team wants to add to Jig does not need to live in Jig. A
tool that speaks one of Jig's command contracts, such as a reflection
store, a validation-plan command or a classify command
([plugin/EXTENDING.md](plugin/EXTENDING.md)), lives in its own repository
under its own licence, passes the contract's checks, and Jig points to it.
That is the normal way in for a tool; an adapter that runs inside the
plugin, such as an issue tracker's, is a pull request to Jig.

## Licence, copyright and name

Jig is licensed under the Apache License 2.0, with its templates under MIT
No Attribution ([README § Licence](README.md#licence)). The copyright is
held by the licensor named in [NOTICE](NOTICE). A contribution from
outside the maintainers is accepted under the same licence with
signed-off commits, the
[Developer Certificate of Origin](GLOSSARY.md), which the maintainer who
merges it checks; Jig asks for no contributor
licence agreement and will not change its licence, so a contributor keeps
their own copyright and nobody can take the work private later.

The name Jig Harness, its short form Jig, the logo and the jig-harness.dev
domain are held apart from the code, by the holder named in [TRADEMARK.md](TRADEMARK.md), so that the
project keeps its name whatever happens to the company that holds the
copyright. [ADR-0006](docs/adr/ADR-0006-home-copyright-and-brand-held-apart.md)
records the arrangement and what happens if either party can no longer
carry its part.

## Reaching the maintainer

The maintainer is [@liqweed](https://github.com/liqweed) on GitHub. For
anything that must stay private, a conduct report, a vulnerability, a
question about the name, use the repository's private report form
(Security, then "Report a vulnerability"; say in the title what it is
about). It is read by the maintainer and by the repository's
administrators, who are the owners of the organization
([ADR-0006](docs/adr/ADR-0006-home-copyright-and-brand-held-apart.md)),
and by nobody else. Anything else goes in an issue or a discussion.

## Succession

The maintainer may hand the role to another person, and names them here.
If the maintainer can no longer act and has named nobody, the holder of the
name decides who maintains Jig next.

## Changing this page

Only the maintainer changes this page, in a pull request that says what
changed and why.
