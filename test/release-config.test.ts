/**
 * The release commit must be recognisable to the workflow that must not
 * re-release it.
 *
 * These two files agree by convention and nothing else. `.releaserc.json`
 * decides what semantic-release's release commit is called;
 * `.github/workflows/release.yml` decides which commits the release job
 * declines to run on. Change the template and the guard stops matching, with
 * no error anywhere — the job simply starts running on its own release
 * commits.
 *
 * The reverse pairing is the one that actually cost something. The guard used
 * to be `[skip ci]` inside that same message, which GitHub honours anywhere in
 * a pushed commit's message. A squash merge concatenates the branch's commit
 * messages, and a `feat/**` branch accumulates `chore(release): ... [skip ci]`
 * prerelease commits by design — so every squashed feature merge carried the
 * marker into `main` and skipped Release and Docs entirely. Seven of the eight
 * merges before the fix released nothing at merge time.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const releaserc = JSON.parse(
  readFileSync(join(repoRoot, ".releaserc.json"), "utf8"),
) as { plugins: Array<string | [string, Record<string, unknown>]> };

const workflow = parseYaml(
  readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8"),
) as { jobs: Record<string, { if?: string }> };

/** The `message` option of the @semantic-release/git plugin entry. */
function releaseCommitTemplate(): string {
  for (const plugin of releaserc.plugins) {
    if (Array.isArray(plugin) && plugin[0] === "@semantic-release/git") {
      const message = plugin[1]["message"];
      if (typeof message === "string") return message;
    }
  }
  throw new Error("no @semantic-release/git plugin with a message option");
}

describe("the release commit guard", () => {
  it("skips exactly the commits semantic-release creates", () => {
    const guard = workflow.jobs["release"]?.if;
    expect(guard, "the release job has no `if:` guard").toBeDefined();

    // Pull the literal the guard compares against, rather than assuming it.
    const match = /startsWith\(github\.event\.head_commit\.message,\s*'([^']+)'\)/.exec(
      guard ?? "",
    );
    expect(
      match,
      `guard does not test a subject prefix: ${guard ?? "(no guard)"}`,
    ).not.toBeNull();
    const prefix = match?.[1] ?? "";

    const template = releaseCommitTemplate();
    const subject = template.split("\n")[0] ?? "";
    // The template is multi-line (subject, blank, notes), so a subject equal to
    // the whole template means the delimiter never matched — which is exactly
    // what a literal `\\n` here did, leaving the assertion below testing the
    // full string while reading as though it tested the subject.
    expect(subject).not.toBe(template);
    expect(
      subject.startsWith(prefix),
      `release commit subject ${JSON.stringify(subject)} does not start with the guarded prefix ${JSON.stringify(prefix)}`,
    ).toBe(true);
  });

  it("still runs when the event has no head commit", () => {
    // `workflow_dispatch` carries no `head_commit`, so a guard written only as
    // `!startsWith(...)` would evaluate against null and skip the job — which
    // is precisely the manual recovery path this repo needed when the release
    // was skipped in the first place.
    const guard = workflow.jobs["release"]?.if ?? "";
    expect(guard).toContain("github.event_name != 'push'");
  });

  it("keeps the release commit message free of a CI-skip marker", () => {
    // The marker is inherited by squash merges. Nothing in this repo can stop
    // that, so the message must not carry one.
    expect(releaseCommitTemplate()).not.toMatch(/skip[ -](ci|actions)/i);
  });
});
