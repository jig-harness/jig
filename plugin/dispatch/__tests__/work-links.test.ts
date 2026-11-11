/**
 * The links between a repository's open pull requests and its items, as the
 * line carries them (`work-links.ts`): read from the branch under the
 * branch-name pattern, from a description's closing lines and from the
 * forge's closing references, each key once, and both ways.
 */
import { describe, expect, it } from "bun:test";
import {
  numberKeys,
  teamKeys,
} from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import {
  closingKeys,
  type LinkRules,
  type PrLinkText,
  workLinks,
} from "../lib/work-links.ts";

const REPO = "example-org/web";
const PATTERN = "{key_lower}-{slug}";

function pr(fields: Partial<PrLinkText> & { number: number }): PrLinkText {
  return {
    url: `https://github.com/${REPO}/pull/${fields.number}`,
    headRefName: "chore-tidy",
    body: "",
    closing: [],
    ...fields,
  };
}

const TEAM: LinkRules = {
  keys: teamKeys("ENG"),
  branchPattern: PATTERN,
  repository: REPO,
  issueRepository: null,
};

const ISSUES: LinkRules = {
  keys: numberKeys(REPO),
  branchPattern: PATTERN,
  repository: REPO,
  issueRepository: REPO,
};

describe("a team key", () => {
  it("is read from a branch do-item named, in canonical form", () => {
    const links = workLinks(
      [pr({ number: 7, headRefName: "eng-42-add-export" })],
      TEAM,
    );
    expect(links.itemsOf(7)).toEqual(["ENG-42"]);
  });

  it("is read from every closing line of a description, each once, the branch's first", () => {
    const links = workLinks(
      [
        pr({
          number: 7,
          headRefName: "eng-42-add-export",
          body: [
            "Adds the export.",
            "",
            "Closes ENG-43, ENG-44 and eng-45",
            "fixes: ENG-42",
            "Resolved ENG-46",
            "See ENG-99 for the background.",
          ].join("\n"),
        }),
      ],
      TEAM,
    );
    expect(links.itemsOf(7)).toEqual([
      "ENG-42",
      "ENG-43",
      "ENG-44",
      "ENG-45",
      "ENG-46",
    ]);
  });

  it("is not read from code, an HTML comment or another team's key", () => {
    const body = [
      "<!-- Closes ENG-1 -->",
      "```",
      "Closes ENG-2",
      "```",
      "Write `Fixes ENG-3` to close one.",
      "Closes OPS-4",
      "prefix ENG-5",
    ].join("\n");
    expect(closingKeys(body, TEAM.keys)).toEqual([]);
  });

  it("is not read from indented or container code, including code with comment delimiters", () => {
    const body = [
      "    Closes ENG-1",
      "> ```",
      "> <!-- Closes ENG-2 -->",
      "> ```",
      "`<!-- Closes ENG-3`",
      "``Closes ENG-4 ` still code``",
      "Closes ENG-5",
    ].join("\n");
    expect(closingKeys(body, TEAM.keys)).toEqual(["ENG-5"]);
  });

  it("is not read from multiline inline code, and accepts a longer closing fence", () => {
    const body = [
      "`Fixes",
      "ENG-1`",
      "```",
      "Closes ENG-2",
      "````",
      "Closes ENG-3",
    ].join("\n");
    expect(closingKeys(body, TEAM.keys)).toEqual(["ENG-3"]);
  });

  it("reads every item in an Oxford-comma list", () => {
    expect(closingKeys("Closes ENG-1, ENG-2, and ENG-3", TEAM.keys)).toEqual([
      "ENG-1",
      "ENG-2",
      "ENG-3",
    ]);
  });

  it("takes no closing reference from the forge: those are its own issues, not the tracker's", () => {
    const links = workLinks(
      [pr({ number: 7, closing: [{ number: 3, repository: REPO }] })],
      TEAM,
    );
    expect(links.itemsOf(7)).toEqual([]);
  });
});

describe("a GitHub issue number, which pull requests share", () => {
  it("is never read from a bare mention", () => {
    const links = workLinks(
      [pr({ number: 9, body: "Follows #3 and supersedes #5.\nPart of #2." })],
      ISSUES,
    );
    expect(links.itemsOf(9)).toEqual([]);
  });

  it("is read from a closing keyword, the forge's closing references and the branch, each once", () => {
    const links = workLinks(
      [
        pr({
          number: 9,
          headRefName: "12-tidy-the-export",
          body: "Closes #12\nFixes #13",
          closing: [
            { number: 12, repository: REPO },
            { number: 14, repository: "Example-Org/Web" },
            { number: 15, repository: "example-org/other" },
          ],
        }),
      ],
      ISSUES,
    );
    expect(links.itemsOf(9)).toEqual(["#12", "#13", "#14"]);
  });

  it("is taken only from the forge's closing references when the issues live in another repository", () => {
    const links = workLinks(
      [
        pr({
          number: 9,
          body: "Closes #12",
          closing: [{ number: 20, repository: "example-org/tracker" }],
        }),
      ],
      { ...ISSUES, issueRepository: "example-org/tracker" },
    );
    expect(links.itemsOf(9)).toEqual(["#20"]);
  });
});

describe("the reverse map", () => {
  it("lists every open pull request linked to an item, by number, each once", () => {
    const links = workLinks(
      [
        pr({ number: 30, body: "Closes ENG-1" }),
        pr({ number: 21, headRefName: "eng-1-first-try", body: "Fixes ENG-1" }),
        pr({ number: 25, body: "Closes ENG-2" }),
      ],
      TEAM,
    );
    expect(links.prsOf("ENG-1")).toEqual([
      { number: 21, url: `https://github.com/${REPO}/pull/21` },
      { number: 30, url: `https://github.com/${REPO}/pull/30` },
    ]);
    expect(links.prsOf("eng-2").map((p) => p.number)).toEqual([25]);
    expect(links.prsOf("ENG-3")).toEqual([]);
  });

  it("knows nothing of a pull request the read did not hold", () => {
    const links = workLinks([pr({ number: 7 })], TEAM);
    expect(links.itemsOf(7)).toEqual([]);
    expect(links.itemsOf(8)).toBeNull();
  });
});
