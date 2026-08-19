/**
 * SARIF 2.1.0 — the interchange format GitHub code scanning, GitLab, and Azure
 * DevOps ingest directly.
 *
 * What `--format github` cannot do is persist: `::error` workflow commands
 * render on the pull request and then vanish with the job log. SARIF findings
 * become tracked alerts with state across commits, which is what makes "when
 * did this regress" and "is metadata debt trending down" answerable at all.
 *
 * Three properties carry that tracking, and each has a trap:
 *
 * - **`artifactLocation.uri` must be repository-root-relative.** GitHub
 *   resolves it against the repository root and *silently drops* results that
 *   do not resolve — the upload succeeds, with zero alerts. `ValidationResult`
 *   labels are relative to whatever the run resolved against, which is only
 *   coincidentally the repository root, so they are rebased here.
 * - **`ruleId` must not be built from prose.** See `./rule-id.ts`.
 * - **`partialFingerprints` must match the baseline's fingerprint.** One
 *   identity function, two consumers.
 */
import { isAbsolute } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import type { FieldError, ValidationResult } from "../types.js";
import {
  canonicalFilePath,
  canonicalSchemaRef,
  fingerprint,
  type FingerprintContext,
} from "../core/baseline.js";
import { findGitRoot } from "../core/config.js";
import { RESERVED_RULES, fieldLabel, ruleIdFor } from "./rule-id.js";

/** Where a consumer is sent to read about docmeta itself. */
const INFORMATION_URI = "https://hawkeyexl.github.io/docmeta/";

/** Where a consumer is sent to read about one finding. */
const HELP_URI = "https://hawkeyexl.github.io/docmeta/fix/";

/** The property-bag key GitHub keys alert identity on. Versioned deliberately. */
const FINGERPRINT_KEY = "docmetaViolation/v1";

/** Not a path anyone can resolve, so it can never be an artifact location. */
const STDIN_LABEL = "<stdin>";

/**
 * Said once, on stderr, when SARIF paths could not be made
 * repository-root-relative — the `GITIGNORE_UNAVAILABLE` precedent. Degrading
 * in silence is the wrong failure here: a uri that does not resolve produces a
 * *successful* upload with no alerts, so nothing downstream ever complains.
 */
export const SARIF_NO_GIT_ROOT =
  "SARIF paths could not be made repository-root-relative: no git repository was found here. GitHub code scanning resolves artifactLocation.uri against the repository root and drops results that do not resolve, so an upload may report no findings at all.";

export interface SarifOptions {
  /** The run's path frame. Without one, `file` labels are emitted as they are. */
  frame?: FingerprintContext;
  /** Diagnostics for the user; the CLI writes these to stderr. */
  onNotice?: (message: string) => void;
}

interface SarifRule {
  id: string;
  shortDescription: { text: string };
  helpUri: string;
}

interface SarifResult {
  ruleId: string;
  level: "error";
  message: { text: string };
  locations: {
    physicalLocation: {
      artifactLocation: { uri: string };
      region?: { startLine: number };
    };
  }[];
  partialFingerprints: Record<string, string>;
}

/**
 * What a rule *is*, in one line.
 *
 * Only the reserved rules get bespoke prose; everything else is named by the
 * schema and keyword that produced it, which is all docmeta actually knows. A
 * per-keyword phrasebook would be prose docmeta would then have to keep in step
 * with Ajv's own vocabulary for no consumer benefit.
 */
function describeRule(id: string, e: FieldError, schemaRef: string): string {
  return (
    RESERVED_RULES[id] ??
    `Schema "${schemaRef}" rejected the document on its "${e.keyword}" keyword.`
  );
}

/**
 * Said when a result had to be dropped because its path lies outside the
 * repository.
 *
 * Dropping is the only truthful option — GitHub would drop it anyway, having
 * failed to resolve it — but doing so in silence reproduces the exact failure
 * this reporter exists to prevent: an upload that succeeds while reporting
 * fewer findings than the run actually made.
 */
export const sarifDroppedNotice = (n: number): string =>
  `${n} SARIF ${n === 1 ? "finding lies" : "findings lie"} outside the repository and ${n === 1 ? "was" : "were"} omitted: an artifactLocation.uri that leaves the repository root cannot be resolved by a code-scanning consumer.`;

/**
 * The frame `artifactLocation.uri` is measured against.
 *
 * Same rebase `canonicalFilePath` already performs for baseline keys, with
 * `base` swapped for the repository root. Returns null when there is nothing to
 * rebase against, which the caller reports rather than papers over.
 */
function uriFrame(frame: FingerprintContext): FingerprintContext | null {
  const root = findGitRoot(frame.cwd);
  return root === null ? null : { ...frame, base: root };
}

/**
 * A uri SARIF accepts: relative, posix, and never climbing out of the
 * repository.
 *
 * A file above the repository root rebases to `../…`, which SARIF permits but
 * GitHub cannot resolve. There is nothing truthful to emit for it, so the
 * result is dropped rather than pointed at a path that does not exist — the
 * same reasoning that skips `<stdin>`.
 */
function artifactUri(
  file: string,
  frame: FingerprintContext | undefined,
): string | null {
  const uri = canonicalFilePath(file, frame);
  // An absolute path is not a repository-relative uri either. `relative()`
  // returns one when the two paths share no root, which on Windows is any
  // checkout and temp directory on different drives.
  if (uri === "" || uri.startsWith("../") || isAbsolute(uri)) return null;
  return uri;
}

export function renderSarif(
  results: ValidationResult[],
  opts: SarifOptions = {},
): string {
  const { frame, onNotice } = opts;

  // Two frames, deliberately: fingerprints stay measured against the config's
  // directory (so a baseline recorded from anywhere matches), while uris are
  // measured against the repository root (so GitHub can resolve them).
  const rebased = frame ? uriFrame(frame) : undefined;
  if (frame && rebased === null) onNotice?.(SARIF_NO_GIT_ROOT);
  const pathFrame = rebased ?? frame;

  const rules = new Map<string, SarifRule>();
  const sarifResults: SarifResult[] = [];
  let dropped = 0;

  for (const r of results) {
    if (r.errors.length === 0) continue;
    // `<stdin>` is not a path; nothing is lost by leaving it out, so it is not
    // counted as a drop.
    if (r.file === STDIN_LABEL) continue;
    const uri = artifactUri(r.file, pathFrame);
    if (uri === null) {
      dropped += r.errors.length;
      continue;
    }

    for (const e of r.errors) {
      const ruleId = ruleIdFor(e, frame);
      if (!rules.has(ruleId)) {
        rules.set(ruleId, {
          id: ruleId,
          shortDescription: {
            text: describeRule(ruleId, e, canonicalSchemaRef(e.schema, frame)),
          },
          helpUri: HELP_URI,
        });
      }
      sarifResults.push({
        ruleId,
        // Everything is `error`: docmeta has no severity concept to map onto
        // SARIF's triage axis. Tracked as issue #78, not hidden here.
        level: "error",
        message: { text: `${fieldLabel(e.instancePath)} ${e.message}` },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri },
              // SARIF requires `startLine >= 1`. `0` is schema-invalid and `1`
              // silently mislocates the finding at the top of the file, so an
              // unknown line omits the region and renders file-level, which is
              // true. No extractor populates `col`, so no `startColumn`.
              ...(e.line != null ? { region: { startLine: e.line } } : {}),
            },
          },
        ],
        partialFingerprints: { [FINGERPRINT_KEY]: fingerprint(e, frame) },
      });
    }
  }

  if (dropped > 0) onNotice?.(sarifDroppedNotice(dropped));

  return `${JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "docmeta",
              version: pkg.version,
              informationUri: INFORMATION_URI,
              // Only rules this run actually hit. Enumerating every keyword of
              // every schema would mean compiling and walking each one, for no
              // consumer benefit.
              rules: [...rules.values()],
            },
          },
          results: sarifResults,
        },
      ],
    },
    null,
    2,
  )}`;
}
