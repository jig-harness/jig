import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REMOTE, remoteName, reviewConfig } from "../consumer.ts";

function withOverlay(value: unknown, check: () => void): void {
  const directory = mkdtempSync(join(tmpdir(), "review-consumer-"));
  const previous = process.env.JIG_OVERLAY;
  try {
    const path = join(directory, "overlay.json");
    writeFileSync(path, JSON.stringify(value));
    process.env.JIG_OVERLAY = path;
    check();
  } finally {
    if (previous === undefined) delete process.env.JIG_OVERLAY;
    else process.env.JIG_OVERLAY = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [field, tokens] of [
  ["context_prefixes", ["owner:", "area:"]],
  ["types", ["bug"]],
  ["repos", ["project"]],
] as const)
  test(`declaring ${field} cannot silently disable batch ownership checks`, () => {
    withOverlay({ review: { taxonomy: { [field]: tokens } } }, () => {
      expect(reviewConfig).toThrow("ownership_prefixes is required");
    });
  });

test("an empty ownership set cannot disable the same checks", () => {
  withOverlay(
    {
      review: {
        taxonomy: { context_prefixes: ["owner:"], ownership_prefixes: [] },
      },
    },
    () =>
      expect(reviewConfig).toThrow(
        "ownership_prefixes must contain distinct nonempty strings",
      ),
  );
});

test("a consumer can declare its own ownership prefixes", () => {
  const taxonomy = {
    context_prefixes: ["owner:", "area:"],
    ownership_prefixes: ["owner:"],
    types: ["bug"],
    repos: ["project"],
  };
  withOverlay({ review: { taxonomy } }, () => {
    expect(reviewConfig().taxonomy).toEqual(taxonomy);
  });
});

test("non-deferral consumers do not need a batching taxonomy", () => {
  withOverlay({ review: { bots: ["review-bot[bot]"] } }, () => {
    expect(reviewConfig()).toEqual({ bots: ["review-bot[bot]"] });
  });
  withOverlay({}, () => expect(reviewConfig()).toEqual({}));
});

for (const value of [[], "AI review", [""], [" "], [42], ["review", "review"]])
  test(`invalid required check names fail closed: ${JSON.stringify(value)}`, () => {
    withOverlay({ review: { required_checks: value } }, () => {
      expect(reviewConfig).toThrow(
        "review.required_checks must contain distinct nonempty check names",
      );
    });
  });

test("required check names come from consumer policy", () => {
  withOverlay({ review: { required_checks: ["custom-check"] } }, () => {
    expect(reviewConfig().required_checks).toEqual(["custom-check"]);
  });
});

test("a skill reads the configuration layers through layeredConfig, never the loader itself", () => {
  const plugin = join(import.meta.dir, "..", "..");
  const allowed = new Set(["shared/config-layers.ts", "shared/consumer.ts"]);
  // Bun.Glob yields native separators; compared with forward slashes.
  const callers = [...new Bun.Glob("**/*.ts").scanSync(plugin)]
    .map((file) => file.replaceAll("\\", "/"))
    .filter(
      (file) =>
        !file.includes("__tests__/") &&
        !allowed.has(file) &&
        readFileSync(join(plugin, file), "utf8").includes("loadLayeredConfig"),
    );
  expect(callers).toEqual([]);
});

/**
 * A repository root holding `.config/jig.yaml` with `yaml`, and the
 * environment `remoteName` reads it with: no user layer, no `JIG_OVERLAY`.
 */
function repositoryWith(yaml: string | null): {
  root: string;
  env: Record<string, string | undefined>;
  done: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "consumer-remote-"));
  if (yaml !== null) {
    mkdirSync(join(root, ".config"));
    writeFileSync(join(root, ".config", "jig.yaml"), yaml);
  }
  return {
    root,
    env: { JIG_USER_LAYER: "off" },
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("the remote is origin when repository.remote is unset", () => {
  expect(DEFAULT_REMOTE).toBe("origin");
  for (const yaml of [null, "repository:\n  base_branch: main\n"]) {
    const r = repositoryWith(yaml);
    try {
      expect(remoteName(r.root, r.env)).toBe("origin");
    } finally {
      r.done();
    }
  }
});

test("an environment null over a configured remote is an error, never origin", () => {
  const r = repositoryWith("repository:\n  remote: upstream\n");
  try {
    expect(() =>
      remoteName(r.root, { ...r.env, JIG__REPOSITORY__REMOTE: "null" }),
    ).toThrow(
      /repository\.remote must be a git remote name.*JIG__REPOSITORY__REMOTE/,
    );
  } finally {
    r.done();
  }
});

test("an environment null over the whole repository section is an error, never origin", () => {
  const r = repositoryWith("repository:\n  remote: upstream\n");
  try {
    expect(() =>
      remoteName(r.root, { ...r.env, JIG__REPOSITORY: "null" }),
    ).toThrow(/repository must be a mapping.*JIG__REPOSITORY/);
  } finally {
    r.done();
  }
});

test("a repository section YAML reads as a timestamp is an error, never origin", () => {
  const r = repositoryWith("repository: 2026-10-12\n");
  try {
    expect(() => remoteName(r.root, r.env)).toThrow(
      /repository must be a mapping.*jig\.yaml/,
    );
  } finally {
    r.done();
  }
});

test("the remote is the one repository.remote names, and the environment layer overrides it", () => {
  const r = repositoryWith("repository:\n  remote: upstream\n");
  try {
    expect(remoteName(r.root, r.env)).toBe("upstream");
    expect(
      remoteName(r.root, { ...r.env, JIG__REPOSITORY__REMOTE: "github" }),
    ).toBe("github");
  } finally {
    r.done();
  }
});

for (const value of ["team/upstream", "fork.mirror", "my_remote-2"])
  test(`a remote name with git's allowed separators is accepted: ${value}`, () => {
    const r = repositoryWith(`repository:\n  remote: ${value}\n`);
    try {
      expect(remoteName(r.root, r.env)).toBe(value);
    } finally {
      r.done();
    }
  });

for (const value of [
  '"-upstream"',
  '"up stream"',
  '"up:stream"',
  '""',
  "42",
  "null",
  '"$(id)"',
  '"`id`"',
  '"up;stream"',
  '"upstream.lock"',
  '"team/upstream.lock/x"',
  '"upstream/"',
  '"/upstream"',
  '"upstream//other"',
  '"upstream@{x}"',
  '"up..stream"',
  '".hidden"',
  '"team/.hidden"',
  '"upstream."',
])
  test(`an unusable repository.remote is an error naming its file: ${value}`, () => {
    const r = repositoryWith(`repository:\n  remote: ${value}\n`);
    try {
      expect(() => remoteName(r.root, r.env)).toThrow(
        /repository\.remote must be a git remote name.*\.config[\\/]jig\.yaml/,
      );
    } finally {
      r.done();
    }
  });
