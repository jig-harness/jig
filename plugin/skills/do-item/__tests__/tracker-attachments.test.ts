/**
 * The tracker port's attachments on each built adapter, over fake
 * transports: the file reaches the issue in the form the adapter holds it,
 * reads back unchanged, and a new file replaces older ones only once the
 * issue lists it.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { parseAttachRequest } from "../scripts/lib/attachment-ops.ts";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import {
  AttachmentRefused,
  type AttachmentFile,
  attachReplacing,
  type IssueAttachment,
} from "../scripts/lib/tracker/attachment.ts";
import { LinearApiError } from "../scripts/lib/tracker/linear-transport.ts";
import {
  type LinearFiles,
  linearFiles,
} from "../scripts/lib/tracker/linear-attachments.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../scripts/lib/tracker/linear.ts";
import {
  ATTACHMENT_MARKER,
  GITHUB_COMMENT_LIMIT,
} from "../scripts/lib/tracker/github/attachments.ts";
import { httpTransport as jiraHttp } from "../scripts/lib/tracker/jira/transport.ts";
import { jiraAuthorization } from "../scripts/lib/tracker/jira/credential.ts";
import {
  conn,
  gitHub,
  issueNode,
  oneIssue,
  writes,
} from "./github-fixtures.ts";
import { jira, routes, SITE, writes as jiraWrites } from "./jira-fixtures.ts";

const HTML = "<!doctype html>\n<p>Decision `sheet` ```</p>\n";
const bytesOf = (text: string) => new TextEncoder().encode(text);
const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const sheet = (over: Partial<AttachmentFile> = {}): AttachmentFile => ({
  filename: "ENG-1-decision-sheet.html",
  contentType: "text/html",
  bytes: bytesOf(HTML),
  title: "Decision sheet: ENG-1",
  subtitle: "Open · facts verified 2026-11-01 @ abc1234",
  ...over,
});

// ── Linear ─────────────────────────────────────────────────────────────────

const ASSET = "https://uploads.linear.app/org/asset-1";

type LinearCall = { op: string; variables: Record<string, unknown> };

function linear(
  answer: (call: LinearCall) => unknown,
  stored: Record<string, Uint8Array> = {},
) {
  const calls: LinearCall[] = [];
  const puts: Array<{
    url: string;
    headers: Record<string, string>;
    bytes: Uint8Array;
  }> = [];
  const transport: LinearTransport = async (query, variables) => {
    const call = {
      op: /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?",
      variables,
    };
    calls.push(call);
    const out = answer(call);
    if (out instanceof Error) throw out;
    return out;
  };
  const files: LinearFiles = {
    async put(url, headers, bytes) {
      puts.push({ url, headers, bytes });
      stored[ASSET] = bytes;
    },
    async get(url) {
      const b = stored[url];
      if (b === undefined) throw new Error(`nothing stored at ${url}`);
      return b;
    },
  };
  const t = linearTracker({
    team: "ENG",
    states: parseTrackerConfig({}).states,
    transport,
    files,
  });
  return { t, calls, puts };
}

const linearNode = (
  id: string,
  title: string,
  url = ASSET,
  filename?: string,
) => ({
  id,
  title,
  subtitle: null,
  url,
  createdAt: "2026-11-01T00:00:00Z",
  metadata: filename === undefined ? {} : { filename },
});

const linearList = (...nodes: unknown[]) => ({
  issue: {
    attachments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
  },
});

describe("Linear attachments", () => {
  it("uploads the file to Linear's store and attaches it to the issue", async () => {
    const { t, calls, puts } = linear((c) => {
      if (c.op === "TrackerIssueId")
        return { issue: { id: "uuid-1", team: { id: "team-1", key: "ENG" } } };
      if (c.op === "TrackerFileUpload")
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: "https://storage.example/put?sig=1",
              assetUrl: ASSET,
              headers: [{ key: "x-goog-meta-a", value: "1" }],
            },
          },
        };
      if (c.op === "TrackerAttachmentCreate")
        return {
          attachmentCreate: {
            success: true,
            attachment: {
              ...linearNode("att-1", "Decision sheet: ENG-1"),
              metadata: (c.variables.input as Record<string, unknown>).metadata,
            },
          },
        };
      return new Error(`unexpected ${c.op}`);
    });
    const a = await t.attachFile("ENG-1", sheet());
    expect(calls.map((c) => c.op)).toEqual([
      "TrackerIssueId",
      "TrackerFileUpload",
      "TrackerAttachmentCreate",
    ]);
    expect(calls[1]?.variables).toEqual({
      contentType: "text/html",
      filename: "ENG-1-decision-sheet.html",
      size: bytesOf(HTML).byteLength,
    });
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toBe("https://storage.example/put?sig=1");
    expect(puts[0]?.headers).toMatchObject({
      "Content-Type": "text/html",
      "x-goog-meta-a": "1",
    });
    expect(textOf(puts[0]?.bytes as Uint8Array)).toBe(HTML);
    expect(calls[2]?.variables.input).toMatchObject({
      issueId: "uuid-1",
      title: "Decision sheet: ENG-1",
      subtitle: "Open · facts verified 2026-11-01 @ abc1234",
      url: ASSET,
      metadata: { filename: "ENG-1-decision-sheet.html" },
    });
    expect(a).toMatchObject({
      id: "att-1",
      form: "upload",
      filename: "ENG-1-decision-sheet.html",
    });
  });

  it("reads a stored file back, and refuses one Linear only links", async () => {
    const { t } = linear(
      () =>
        linearList(
          linearNode("att-1", "Decision sheet: ENG-1"),
          linearNode("att-2", "PR #4", "https://github.com/acme/app/pull/4"),
        ),
      { [ASSET]: bytesOf(HTML) },
    );
    expect(textOf(await t.readAttachment("ENG-1", "att-1"))).toBe(HTML);
    await expect(t.readAttachment("ENG-1", "att-2")).rejects.toBeInstanceOf(
      AttachmentRefused,
    );
  });

  it("removes only an attachment the issue has", async () => {
    const { t, calls } = linear((c) =>
      c.op === "TrackerAttachments"
        ? linearList(linearNode("att-1", "Decision sheet: ENG-1"))
        : { attachmentDelete: { success: true } },
    );
    await expect(t.removeAttachment("ENG-1", "att-9")).rejects.toThrow(
      "ENG-1 has no attachment att-9",
    );
    expect(calls.map((c) => c.op)).toEqual(["TrackerAttachments"]);
    await t.removeAttachment("ENG-1", "att-1");
    expect(calls.at(-1)).toEqual({
      op: "TrackerAttachmentDelete",
      variables: { id: "att-1" },
    });
  });

  it("never sends the API key to a host other than Linear's file store", async () => {
    const asked: string[] = [];
    const files = linearFiles("lin_api_key", (async (url: string) => {
      asked.push(String(url));
      return new Response("x");
    }) as typeof fetch);
    await expect(files.get("https://elsewhere.example/a")).rejects.toThrow(
      "not a file Linear stores",
    );
    expect(asked).toEqual([]);
  });

  it("sends the API key only over HTTPS on the default port, and never uploads to a plain-HTTP address", async () => {
    const asked: string[] = [];
    const files = linearFiles("lin_api_key", (async (url: string) => {
      asked.push(String(url));
      return new Response("x");
    }) as typeof fetch);
    for (const url of [
      "http://uploads.linear.app/a",
      "https://uploads.linear.app:8443/a",
    ])
      await expect(files.get(url)).rejects.toThrow("not a file Linear stores");
    await expect(
      files.put("http://storage.example/a", {}, new Uint8Array()),
    ).rejects.toThrow("not an HTTPS upload address");
    for (const url of [
      "https://upload.attacker.example/put",
      "https://evilstorage.googleapis.com.attacker.example/put",
      "https://storage.googleapis.com:8443/put",
      "https://127.0.0.1/upload",
      "https://[::1]/upload",
      "https://localhost/upload",
      "https://build.internal/upload",
    ])
      await expect(files.put(url, {}, new Uint8Array())).rejects.toThrow(
        "Linear's file storage",
      );
    expect(asked).toEqual([]);
    await files.put(
      "https://storage.googleapis.com/linear-uploads/x?sig=1",
      {},
      new Uint8Array(),
    );
    expect(asked).toEqual([
      "https://storage.googleapis.com/linear-uploads/x?sig=1",
    ]);
  });

  it("names the uploaded address when attaching it fails", async () => {
    const { t } = linear((call) => {
      if (call.op === "TrackerIssueId")
        return { issue: { id: "I_1", team: { id: "team-1", key: "ENG" } } };
      if (call.op === "TrackerFileUpload")
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: "https://storage.example/u",
              assetUrl: ASSET,
              headers: [],
            },
          },
        };
      return new LinearApiError("boom", 500);
    });
    await expect(t.attachFile?.("ENG-1", sheet())).rejects.toThrow(ASSET);
  });
});

// ── GitHub Issues ──────────────────────────────────────────────────────────

/** A GitHub tracker whose issue #5 holds `comments`; new comments are added to them. */
function gitHubIssue(comments: Array<Record<string, unknown>> = []) {
  let n = 0;
  return gitHub((call) => {
    if (call.op === "TrackerIssue") return oneIssue(issueNode({ number: 5 }));
    if (call.op === "TrackerAttachmentComments")
      return { repository: { issue: { comments: conn(comments) } } };
    if (call.op === "TrackerAttachComment") {
      n += 1;
      const node = {
        id: `IC_new${n}`,
        url: `https://github.com/acme/app/issues/5#issuecomment-${n}`,
        createdAt: "2026-11-02T00:00:00Z",
      };
      comments.push({
        ...node,
        body: call.variables.body,
        authorAssociation: "NONE",
        viewerDidAuthor: true,
      });
      return { addComment: { commentEdge: { node } } };
    }
    if (call.op === "TrackerDeleteAttachment") {
      const at = comments.findIndex((c) => c.id === call.variables.id);
      comments.splice(at, 1);
      return { deleteIssueComment: { clientMutationId: null } };
    }
    return new Error(`unexpected ${call.op}`);
  });
}

describe("GitHub Issues attachments", () => {
  it("carries a text file that fits in a marked comment, and reads it back unchanged", async () => {
    const { t, calls } = gitHubIssue();
    const a = await t.attachFile("#5", sheet());
    expect(writes(calls)).toEqual(["TrackerAttachComment"]);
    const body = String(calls.at(-1)?.variables.body);
    expect(body.startsWith(ATTACHMENT_MARKER)).toBe(true);
    expect(body).toContain("<details>");
    expect(calls.at(-1)?.variables.subjectId).toBe("I_5");
    expect(a).toMatchObject({
      form: "comment",
      title: "Decision sheet: ENG-1",
      filename: "ENG-1-decision-sheet.html",
    });
    expect(await t.listAttachments("#5")).toEqual([a]);
    expect(textOf(await t.readAttachment("#5", a.id))).toBe(HTML);
  });

  it("reads back a text file that starts with a byte-order mark byte for byte", async () => {
    const { t } = gitHubIssue();
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
    const a = await t.attachFile("#5", sheet({ bytes }));
    expect([...(await t.readAttachment("#5", a.id))]).toEqual([...bytes]);
  });

  it("refuses a file too long for one comment, writing nothing, and links a hosted copy instead", async () => {
    const { t, calls } = gitHubIssue();
    const long = sheet({ bytes: bytesOf("x".repeat(GITHUB_COMMENT_LIMIT)) });
    await expect(t.attachFile("#5", long)).rejects.toBeInstanceOf(
      AttachmentRefused,
    );
    expect(writes(calls)).toEqual([]);
    const a = await t.attachFile("#5", {
      ...long,
      url: "https://files.example/ENG-1-decision-sheet.html",
    });
    expect(a).toMatchObject({
      form: "link",
      url: "https://files.example/ENG-1-decision-sheet.html",
    });
    await expect(t.readAttachment("#5", a.id)).rejects.toBeInstanceOf(
      AttachmentRefused,
    );
  });

  it("refuses a binary file and a link that is not https", async () => {
    const { t, calls } = gitHubIssue();
    await expect(
      t.attachFile(
        "#5",
        sheet({
          contentType: "image/png",
          filename: "a.png",
          bytes: new Uint8Array([137, 80, 0]),
        }),
      ),
    ).rejects.toBeInstanceOf(AttachmentRefused);
    await expect(
      t.attachFile("#5", sheet({ url: "http://files.example/a.html" })),
    ).rejects.toBeInstanceOf(AttachmentRefused);
    expect(writes(calls)).toEqual([]);
  });

  it("lists no marked comment by an untrusted author, and reads a changed one as changed", async () => {
    const comments: Array<Record<string, unknown>> = [];
    const { t } = gitHubIssue(comments);
    const a = await t.attachFile("#5", sheet());
    const carried = String(comments[0]?.body);
    comments[0] = { ...comments[0], viewerDidAuthor: false };
    expect(await t.listAttachments("#5")).toEqual([]);
    comments[0] = {
      ...comments[0],
      viewerDidAuthor: true,
      body: carried.replace("<p>Decision", "<p>Edited!"),
    };
    await expect(t.readAttachment("#5", a.id)).rejects.toThrow(
      "changed since it was attached",
    );
  });

  it("reads a same-length edit of a carried file as changed", async () => {
    const comments: Array<Record<string, unknown>> = [];
    const { t } = gitHubIssue(comments);
    const a = await t.attachFile("#5", sheet({ bytes: bytesOf("safe") }));
    comments[0] = {
      ...comments[0],
      body: String(comments[0]?.body).replace("\nsafe\n", "\nevil\n"),
    };
    await expect(t.readAttachment("#5", a.id)).rejects.toThrow(
      "changed since it was attached",
    );
  });

  it("refuses a link comment over the limit, and a text of a million backticks without a RangeError", async () => {
    const { t, calls } = gitHubIssue();
    await expect(
      t.attachFile(
        "#5",
        sheet({
          url: "https://files.example/a.html",
          title: "t".repeat(GITHUB_COMMENT_LIMIT),
        }),
      ),
    ).rejects.toBeInstanceOf(AttachmentRefused);
    await expect(
      t.attachFile("#5", sheet({ bytes: bytesOf("`x".repeat(1_000_000)) })),
    ).rejects.toBeInstanceOf(AttachmentRefused);
    expect(writes(calls)).toEqual([]);
  });
});

// ── Jira ───────────────────────────────────────────────────────────────────

const jiraAttachment = (id: string, filename: string) => ({
  id,
  filename,
  mimeType: "text/html",
  size: 10,
  created: "2026-11-01T09:00:00.000+0000",
  content: `${SITE}/rest/api/3/attachment/content/${id}`,
});

describe("Jira attachments", () => {
  it("uploads the file to the issue as a multipart form", async () => {
    const { t, calls } = jira(
      routes({
        "POST issue/ENG-1/attachments": [
          jiraAttachment("10001", "ENG-1-decision-sheet.html"),
        ],
      }),
    );
    const a = await t.attachFile("ENG-1", sheet());
    expect(jiraWrites(calls)).toEqual(["POST issue/ENG-1/attachments"]);
    const file = calls[0]?.form?.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("ENG-1-decision-sheet.html");
    expect(await (file as Blob).text()).toBe(HTML);
    expect(a).toEqual({
      id: "10001",
      title: "ENG-1-decision-sheet.html",
      subtitle: null,
      filename: "ENG-1-decision-sheet.html",
      url: `${SITE}/rest/api/3/attachment/content/10001`,
      form: "upload",
      createdAt: "2026-11-01T09:00:00.000+0000",
    });
  });

  it("lists, reads and removes an attachment of the issue", async () => {
    const { t, calls } = jira(
      routes({
        "GET issue/ENG-1": {
          key: "ENG-1",
          fields: {
            attachment: [jiraAttachment("10001", "ENG-1-decision-sheet.html")],
          },
        },
        "GET attachment/content/10001": bytesOf(HTML),
        "DELETE attachment/10001": null,
      }),
    );
    expect((await t.listAttachments("ENG-1")).map((a) => a.id)).toEqual([
      "10001",
    ]);
    expect(textOf(await t.readAttachment("ENG-1", "10001"))).toBe(HTML);
    const read = calls.find((c) => c.route === "GET attachment/content/10001");
    expect(read?.bytes).toBe(true);
    expect(read?.query).toEqual({ redirect: false });
    await expect(t.removeAttachment("ENG-1", "10009")).rejects.toThrow(
      "ENG-1 has no attachment 10009",
    );
    await t.removeAttachment("ENG-1", "10001");
    expect(jiraWrites(calls)).toEqual(["DELETE attachment/10001"]);
  });

  it("sends an upload with Jira's no-check header and reads a file as bytes", async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      return String(url).includes("/content/")
        ? new Response(bytesOf(HTML), { status: 200 })
        : new Response("[]", { status: 200 });
    }) as typeof fetch;
    const transport = jiraHttp(
      SITE,
      jiraAuthorization({ kind: "basic", email: "a@example.com", token: "t" }),
      impl,
    );
    const form = new FormData();
    form.append("file", new Blob([bytesOf(HTML)]), "a.html");
    await transport({ method: "POST", path: "issue/ENG-1/attachments", form });
    const headers = sent[0]?.init.headers as Record<string, string>;
    expect(headers["X-Atlassian-Token"]).toBe("no-check");
    expect(headers["Content-Type"]).toBeUndefined();
    expect(sent[0]?.init.body).toBe(form);
    const got = await transport({
      method: "GET",
      path: "attachment/content/10001",
      bytes: true,
    });
    expect(textOf(got as Uint8Array)).toBe(HTML);
  });
});

// ── Replacing older attachments ────────────────────────────────────────────

describe("attachReplacing", () => {
  const listed = (...as: Array<Partial<IssueAttachment> & { id: string }>) =>
    as.map(
      (a): IssueAttachment => ({
        title: "Other",
        subtitle: null,
        filename: null,
        url: null,
        form: "upload",
        createdAt: null,
        ...a,
      }),
    );

  function fakeTracker(after: IssueAttachment[], fail: string[] = []) {
    const removed: string[] = [];
    return {
      removed,
      tracker: {
        attachFile: async () => ({ ...after[0], id: "new" }) as IssueAttachment,
        listAttachments: async () => after,
        removeAttachment: async (_key: string, id: string) => {
          if (fail.includes(id)) throw new Error(`cannot remove ${id}`);
          removed.push(id);
        },
      },
    };
  }

  it("removes the older attachments with the same file name or title, once the new one is listed", async () => {
    const after = listed(
      { id: "new", title: "Decision sheet: ENG-1", filename: "a.html" },
      { id: "old-title", title: "Decision sheet: ENG-1" },
      { id: "old-file", title: "Renamed", filename: "a.html" },
      { id: "pr", title: "PR #4" },
      { id: "stuck", title: "Decision sheet: ENG-1" },
    );
    const f = fakeTracker(after, ["stuck"]);
    const result = await attachReplacing(f.tracker, "ENG-1", sheet(), true);
    expect(f.removed).toEqual(["old-title", "old-file"]);
    expect(result.removed).toEqual(["old-title", "old-file"]);
    expect(result.kept).toEqual([
      { id: "stuck", reason: "cannot remove stuck", failed: true },
    ]);
  });

  it("keeps every older attachment while the issue does not list the new one", async () => {
    const after = listed(
      { id: "new", title: "Decision sheet: ENG-1" },
      { id: "old", title: "Decision sheet: ENG-1" },
    );
    const f = fakeTracker(after);
    f.tracker.listAttachments = async () => after.slice(1);
    const result = await attachReplacing(f.tracker, "ENG-1", sheet(), true);
    expect(f.removed).toEqual([]);
    expect(result.kept.map((k) => k.id)).toEqual(["old"]);
  });

  it("removes only what the issue listed before this call, so a concurrent replacement's new attachment is never removed", async () => {
    const after = listed(
      { id: "new", title: "Decision sheet: ENG-1" },
      { id: "old", title: "Decision sheet: ENG-1" },
      { id: "rival", title: "Decision sheet: ENG-1" },
    );
    const f = fakeTracker(after);
    const first = [after[1]] as IssueAttachment[];
    let reads = 0;
    f.tracker.listAttachments = async () => (reads++ === 0 ? first : after);
    await attachReplacing(f.tracker, "ENG-1", sheet(), true);
    expect(f.removed).toEqual(["old"]);
  });

  it("replaces a sheet whose title names another key when told the title prefix", async () => {
    const after = listed(
      { id: "new", title: "Decision sheet: ENG-9" },
      { id: "old", title: "Decision sheet: ENG-1", filename: "old.html" },
    );
    const f = fakeTracker(after);
    await attachReplacing(
      f.tracker,
      "ENG-9",
      sheet(),
      true,
      undefined,
      "Decision sheet: ",
    );
    expect(f.removed).toEqual(["old"]);
  });

  it("stops on a cancelled removal rather than keeping it as a row", async () => {
    const after = listed(
      { id: "new", title: "Decision sheet: ENG-1" },
      { id: "old", title: "Decision sheet: ENG-1" },
    );
    const f = fakeTracker(after);
    const ctl = new AbortController();
    f.tracker.removeAttachment = async () => {
      ctl.abort();
      throw new Error("aborted");
    };
    await expect(
      attachReplacing(f.tracker, "ENG-1", sheet(), true, ctl.signal),
    ).rejects.toThrow("aborted");
  });
});

// ── The command line ───────────────────────────────────────────────────────

describe("tracker.ts attach", () => {
  it("reads a sheet renderer's whole summary, or its attachment fields", () => {
    const fields = {
      path: ".context/decide/eng-1/ENG-1-decision-sheet.html",
      filename: "ENG-1-decision-sheet.html",
      contentType: "text/html",
      size: 12,
      title: "Decision sheet: ENG-1",
      subtitle: "Open",
      replace: true,
    };
    const expected = {
      path: fields.path,
      size: 12,
      replace: true,
      file: {
        filename: fields.filename,
        contentType: "text/html",
        title: fields.title,
        subtitle: "Open",
      },
    };
    expect(parseAttachRequest(JSON.stringify(fields))).toEqual(expected);
    expect(
      parseAttachRequest(JSON.stringify({ id: "ENG-1", attachment: fields })),
    ).toEqual(expected);
  });

  it("refuses input it cannot take before reaching the tracker", () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-attach-"));
    try {
      const file = join(dir, "sheet.html");
      writeFileSync(file, HTML);
      const input = join(dir, "attachment.json");
      const cases: Array<[string[], unknown, string]> = [
        [
          ["attach", "ENG-1", "--input", input],
          { path: file },
          "'contentType'",
        ],
        [
          ["attach", "ENG-1", "--input", input],
          { path: file, contentType: "text/html", title: "T", colour: 1 },
          "unknown field colour",
        ],
        [
          ["attach", "ENG-1", "--input", input],
          { path: file, contentType: "text/html", title: "T", size: 1 },
          "render it again",
        ],
        [["fetch-attachment", "ENG-1", "att-1"], {}, "needs --out"],
      ];
      for (const [argv, body, expected] of cases) {
        writeFileSync(input, JSON.stringify(body));
        const result = spawnSync(
          process.execPath,
          [join(import.meta.dir, "../scripts/tracker.ts"), ...argv],
          { encoding: "utf8", timeout: 30_000 },
        );
        expectSpawnExit(
          {
            exitCode: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
          },
          2,
        );
        expect(result.stderr).toContain(expected);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
