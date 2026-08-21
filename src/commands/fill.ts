/**
 * `fill` — infer missing or invalid metadata and write back the values it is
 * confident about.
 *
 * The gate order matters, and it is deliberate: **confidence is the last check,
 * not the only one.** A self-reported score is a weak, uncalibrated signal, so
 * three mechanical checks run first and cannot be overridden by a high score:
 *
 *  1. The proposal must satisfy the target property's own subschema — enforced
 *     by the envelope schema inside `completeValidatedJSON`, before `fill` sees
 *     the response at all.
 *  2. It must name a property that was actually a candidate; the envelope's
 *     `additionalProperties: false` makes inventing keys impossible.
 *  3. After merging, the document must still validate. Anything that would
 *     leave the page failing its own schema is reverted.
 *
 * Only then does the confidence threshold apply. Confidence itself is
 * report-only — it is never written into the document.
 */
import { readFile } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import {
  completeValidatedJSON,
  makeProvider,
  resolveProviderIdentityAsync,
  DEFAULT_MODELS,
  JsonCache,
  buildCacheKey,
  sha256,
  pricingFor,
  costOfUsage,
  InferenceError,
  type InferenceProvider,
  type ProviderName,
  type ProviderSelector,
  type ProviderSpec,
  type TokenUsage,
} from "@hawkeyexl/inference";
import { DocmetaError, type FieldError, type MetadataPatch } from "../types.js";
import { resolveRunConfig, schemaTrustRoot } from "../core/config.js";
import {
  assertNonEmpty,
  gitignoreOptions,
  resolveTargetSet,
  STDIN_TOKEN,
} from "../core/load-files.js";
import {
  extractorByName,
  extractorForExtension,
  listFormats,
  supportedExtensions,
} from "../extractors/index.js";
import {
  collectSchemaPins,
  resolveSchemaSetWithSource,
  type ResolvedSchemaSet,
  FILE_SCHEMA_KEY,
} from "../core/resolve-schema.js";
import { loadSchema, schemaLoadOptions } from "../core/schema-registry.js";
import { Validator, compileWithFormats } from "../core/validator.js";
import { writeFileAtomic } from "../core/write-file.js";
import {
  FILL_PROMPT_VERSION,
  FILL_SYSTEM_PROMPT,
  buildEnvelopeSchema,
  buildUserPrompt,
} from "./fill-prompt.js";
import type {
  Candidate,
  FillFileResult,
  FillOptions,
  FillRun,
  FilledField,
  Proposal,
  ProposalSet,
} from "./fill-types.js";

export type {
  Candidate,
  FillFileResult,
  FillOptions,
  FillRun,
  FillSummary,
  FilledField,
  Proposal,
  SkipReason,
} from "./fill-types.js";

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_CONCURRENCY = 4;
/**
 * `auto` detects the highest-priority provider this machine can actually use —
 * an Anthropic key, then an OpenAI key, then the Claude CLI, then a local model
 * that needs no credentials at all. Defaulting to a named provider instead meant
 * `docmeta fill` failed outright for anyone who did not happen to hold that
 * vendor's key.
 */
const DEFAULT_PROVIDER = "auto";
const CACHE_DIR = ".docmeta/cache";

/** What the cache stores: the raw, *pre-gating* proposal for one file. */
interface CachedProposal {
  proposals: ProposalSet;
  usage?: TokenUsage;
}

export async function runFill(opts: FillOptions): Promise<FillRun> {
  const cwd = opts.cwd ?? process.cwd();
  // Explicit CLI inputs win, else config `paths:`; `base` is whichever of the
  // two directories those inputs were written relative to.
  const { config, inputs, base, configDir } = await resolveRunConfig({
    cwd,
    configPath: opts.configPath,
    noConfig: opts.noConfig,
    inputs: opts.inputs,
    onConfigLoaded: opts.onConfigLoaded,
  });
  // How every schema in this run is loaded: the cross-run cache and
  // `--offline`. `fill` calls `loadSchema` directly as well as through the
  // validator, so both have to be handed the same settings.
  const schemaOptions = schemaLoadOptions({
    root: configDir ?? cwd,
    // A relative file ref belongs to the run's directory, not the cache root.
    fileBase: cwd,
    ttlHours: config?.schemaCache?.ttlHours,
    offline: opts.offline ?? config?.offline,
    pins: collectSchemaPins(config),
  });
  // Settled once per run, not per file: finding it is a filesystem walk, and
  // every file in one run shares the same repository.
  const trustRoot = schemaTrustRoot(cwd, configDir);
  const usingStdin = inputs.includes(STDIN_TOKEN);
  if (inputs.length === 0) {
    throw new DocmetaError(
      "No files to fill. Pass paths/globs, or add `paths:` to docmeta.config.yaml.",
    );
  }

  const forcedExtractor = opts.as ? extractorByName(opts.as) : undefined;
  if (opts.as && !forcedExtractor) {
    // `--as` takes an extractor name ("markdown"), so list names — listing
    // extensions here would point the user at the wrong kind of value.
    throw new DocmetaError(
      `Unknown format "${opts.as}". Known formats: ${listFormats()
        .map((f) => f.name)
        .join(", ")}.`,
    );
  }
  if (usingStdin && !forcedExtractor) {
    throw new DocmetaError(
      "Reading from stdin (`-`) requires --as <format> to choose an extractor.",
    );
  }

  // The CLI range-checks its flags, but runFill is also a public API and is
  // called directly from config values, so it validates rather than trusting.
  // A NaN threshold would silently skip every field; a fractional concurrency
  // would be silently truncated by Array.from's ToLength coercion.
  const threshold = requireNumber(
    opts.confidence ?? config?.fill?.confidenceThreshold ?? DEFAULT_THRESHOLD,
    "confidence",
    { min: 0, max: 1 },
  );
  const concurrency = requireNumber(
    opts.concurrency ?? config?.fill?.concurrency ?? DEFAULT_CONCURRENCY,
    "concurrency",
    { min: 1, max: 64, integer: true },
  );
  const maxCostUsd = opts.maxCostUsd ?? config?.fill?.maxCostUsd;
  if (maxCostUsd !== undefined) {
    requireNumber(maxCostUsd, "maxCostUsd", { min: 0, max: Number.MAX_SAFE_INTEGER });
  }
  const dryRun = Boolean(opts.dryRun);
  const only = opts.fields != null ? new Set(opts.fields) : undefined;

  const providerName = (opts.provider ??
    config?.fill?.provider ??
    DEFAULT_PROVIDER) as ProviderSelector;
  const model = opts.model ?? config?.fill?.model;
  const spec = { provider: providerName, model: model ?? null };

  // Check the name up front, and regardless of whether a provider was injected:
  // it costs nothing, and construction is lazy, so a typo would otherwise exit 0
  // on any run where no file happened to need inference.
  assertKnownProvider(providerName);
  assertModelHasProvider(providerName, model);

  // Resolve targets BEFORE identity. Under `auto`, resolving identity probes the
  // environment, the Claude CLI and the local runtime, and that last probe is
  // slow on a machine holding no credentials — so a mistyped glob would spend
  // seconds detecting a provider it is never going to use before failing. The
  // work is wasted in exactly the case where the user most wants a fast answer.
  //
  // Identity is still resolved unconditionally below, so an `--allow-empty` run
  // that legitimately matches nothing still reports which provider it would have
  // used.
  const fileInputs = inputs.filter((i) => i !== STDIN_TOKEN);
  const allowEmpty = opts.allowEmpty ?? config?.allowEmpty;
  const fillExts = opts.exts ?? forcedExtractor?.extensions;
  const fillExclude = [...(config?.exclude ?? []), ...(opts.exclude ?? [])];
  const { files, gitignoreSkipped } = await resolveTargetSet({
    inputs: fileInputs,
    exts: fillExts,
    exclude: fillExclude,
    cwd: base,
    allowEmpty,
    ...gitignoreOptions({
      flag: opts.respectGitignore,
      configured: config?.respectGitignore,
      onNotice: opts.onNotice,
    }),
  });
  assertNonEmpty({
    files,
    inputs: fileInputs,
    usingStdin,
    allowEmpty,
    exclude: fillExclude,
    exts: fillExts,
    gitignoreSkipped,
    action: "filled",
  });

  // Identity comes from the spec, not a constructed provider, so a fully cached
  // run needs no API key at all. Under `auto` this is also where detection runs
  // — it probes the environment, the Claude CLI and the local runtime, but never
  // authenticates, so the no-key property survives.
  //
  // The two branches are kept apart rather than merged behind a cast: an
  // injected provider's `provider()` is a free-form string, and only the
  // resolved path yields a name `makeProvider` can be trusted with.
  let identity: { provider: string; model: string };
  let construct: () => InferenceProvider;

  if (opts.inferenceProvider) {
    const injected = opts.inferenceProvider;
    identity = { provider: injected.provider(), model: injected.modelName() };
    construct = () => injected;
  } else {
    const resolved = await resolveIdentity(spec);
    identity = resolved;
    // Build from the RESOLVED identity, never the spec we started with: under
    // `auto` that spec still says "auto", and the synchronous `makeProvider`
    // rightly refuses to guess. Detection has already run, so the concrete name
    // is known — which keeps construction synchronous and lazy, and that is what
    // lets a fully cached run finish without a key.
    const concrete: ProviderSpec = {
      ...spec,
      provider: resolved.provider,
      model: resolved.model,
    };
    construct = () => makeProvider(concrete);
  }

  let provider: InferenceProvider | undefined;
  const getProvider = (): InferenceProvider => {
    if (!provider) {
      try {
        provider = construct();
      } catch (err) {
        // Missing API key / unknown provider is operational, not per-file.
        throw new DocmetaError(
          err instanceof InferenceError
            ? err.message
            : `Could not construct the "${providerName}" provider: ${(err as Error).message}`,
        );
      }
    }
    return provider;
  };

  const cache =
    opts.cache === false
      ? undefined
      : new JsonCache<CachedProposal>(join(cwd, CACHE_DIR), true, "docmeta");
  const pricing = pricingFor(identity.model);

  const validator = new Validator(schemaOptions);
  let costUsd = 0;
  let cachedCount = 0;
  let budgetExhausted = false;
  let inFlight = 0;
  let billedCalls = 0;

  /**
   * Spend already incurred, plus a reservation for the calls currently in
   * flight. Without the reservation, `concurrency` calls could all clear a
   * check made against a total that none of them had contributed to yet, and
   * the budget would overshoot by that many calls.
   *
   * The check and the `inFlight++` that follows it are not separated by an
   * await, so they are atomic with respect to the event loop — two workers
   * cannot both pass a check that only one of them fits into.
   */
  const projectedCost = (): number =>
    costUsd + (billedCalls > 0 ? (costUsd / billedCalls) * inFlight : 0);

  const overBudget = (): boolean =>
    maxCostUsd != null && projectedCost() >= maxCostUsd;

  // The reservation needs an observed per-call cost, which does not exist until
  // one call has finished. So when a budget is set, the first call runs alone
  // and the rest wait for it; without this the entire first wave clears a check
  // against $0 and the budget is meaningless for its first `concurrency` files.
  let primingDone: Promise<void> | null = null;
  let releasePriming: (() => void) | null = null;
  const awaitPriming = async (): Promise<void> => {
    if (maxCostUsd == null || billedCalls > 0) return;
    if (primingDone === null) {
      primingDone = new Promise<void>((res) => {
        releasePriming = res;
      });
      return; // this worker is the primer
    }
    await primingDone;
  };
  const finishPriming = (): void => {
    releasePriming?.();
    releasePriming = null;
  };

  const processOne = async (
    label: string,
    content: string,
    extension: string,
  ): Promise<FillFileResult> => {
    const extractor = forcedExtractor ?? extractorForExtension(extension);
    if (!extractor) {
      return errorResult(
        label,
        "unknown",
        `Unsupported file type "${extension}". Supported: ${supportedExtensions().join(", ")}. Use --as to override.`,
      );
    }
    if (typeof extractor.apply !== "function") {
      return errorResult(
        label,
        extractor.name,
        `The "${extractor.name}" format is read-only; docmeta fill cannot write metadata back to it.`,
      );
    }

    let extracted;
    try {
      extracted = extractor.extract(content, label);
    } catch (err) {
      return errorResult(label, extractor.name, (err as Error).message);
    }

    let resolved: ResolvedSchemaSet;
    try {
      resolved = resolveSchemaSetWithSource({
        filePath: label,
        fileSchema: extracted.data[FILE_SCHEMA_KEY],
        cliSchemas: opts.cliSchemas,
        config,
        // Same trust boundary as `validate`: `fill` writes metadata back into
        // the document, so a schema a document chose for itself decides what
        // gets written — if anything, a stronger reason to guard it.
        fileBase: cwd,
        trustRoot,
        onNotice: opts.onNotice,
      });
    } catch (err) {
      return errorResult(label, extractor.name, (err as Error).message);
    }

    const schemaSet = resolved.schemas;
    let schemas: Record<string, unknown>[];
    let existingErrors;
    try {
      schemas = await Promise.all(
        schemaSet.map((ref) => loadSchema(ref, schemaOptions)),
      );
      existingErrors = await validator.validate(
        extracted.data,
        schemaSet,
        extracted.lineFor,
        extracted.colFor,
      );
    } catch (err) {
      // Same rule as `validate`: a schema the *document* chose failing to load
      // is that document's failure and is reported as one, so one file cannot
      // abort the run. Every other source stays operational, because a schema
      // the operator configured invalidates every file, not just this one.
      if (!(err instanceof DocmetaError) || resolved.source !== "document") {
        throw err;
      }
      return errorResult(label, extractor.name, err.message);
    }
    const candidates = collectCandidates(
      schemas,
      extracted.data,
      existingErrors,
      only,
    );
    if (candidates.length === 0) {
      return {
        file: label,
        format: extractor.name,
        schemas: schemaSet,
        fields: [],
        changed: false,
        ...(opts.includeContent ? { content } : {}),
      };
    }

    // Probe writability with an empty patch *before* paying for inference.
    // rst/asciidoc accept `apply` but reject documents that use their native
    // metadata syntax, and finding that out afterwards means the call is
    // billed for a file that could never have been written.
    try {
      extractor.apply(content, {}, { filePath: label });
    } catch (err) {
      return errorResult(label, extractor.name, (err as Error).message, schemaSet);
    }

    // ---- Propose (cache first) -------------------------------------------
    const cacheKey = buildCacheKey([
      identity.provider,
      identity.model,
      `fill-v${FILL_PROMPT_VERSION}`,
      schemaSet.join(","),
      candidates.map((c) => c.key).join(","),
      sha256(content),
    ]);
    const hit = cache?.get(cacheKey);

    let proposals: ProposalSet;
    if (hit) {
      cachedCount++;
      proposals = hit.proposals;
    } else {
      // Wait behind the priming call, if one is in progress, so the budget
      // check below sees a real per-call cost rather than $0.
      await awaitPriming();
      if (overBudget()) {
        budgetExhausted = true;
        return errorResult(
          label,
          extractor.name,
          "Skipped: cost budget reached before this file was processed.",
          schemaSet,
        );
      }
      const envelope = buildEnvelopeSchema(candidates, collectDefs(schemas));
      // The library's own Ajv has no ajv-formats, so a lifted subschema with
      // `format: "date-time"` would fail to compile. Compile it ourselves — and
      // keep the failure per-file, since an unresolvable `$ref` in one schema
      // must not abort a whole directory walk.
      let validate;
      try {
        validate = compileWithFormats(envelope);
      } catch (err) {
        return errorResult(
          label,
          extractor.name,
          `Could not build a proposal schema from ${schemaSet.join(", ")}: ${(err as Error).message}`,
          schemaSet,
        );
      }
      inFlight++;
      let run;
      try {
        run = await completeValidatedJSON<ProposalSet>({
          provider: getProvider(),
          system: FILL_SYSTEM_PROMPT,
          user: buildUserPrompt({
            filePath: label,
            existing: extracted.data,
            candidates,
            // Whole file as context; truncation happens in buildUserPrompt.
            body: content,
          }),
          schema: envelope,
          validate,
        });
        // Bank the cost before releasing waiters, so the first of them sees a
        // real per-call figure rather than the $0 it started with.
        costUsd += costOfUsage(run.usage, pricing);
        billedCalls++;
      } finally {
        inFlight--;
        // In the finally so a throw (e.g. a missing API key surfacing from
        // getProvider) cannot leave the other workers waiting forever.
        finishPriming();
      }
      if (run.error != null || run.result == null) {
        return errorResult(
          label,
          extractor.name,
          run.error ?? "The model returned no proposal.",
          schemaSet,
        );
      }
      proposals = run.result;
      cache?.set(cacheKey, { proposals, ...(run.usage ? { usage: run.usage } : {}) });
    }

    // ---- Gate -------------------------------------------------------------
    const fields = gate(candidates, proposals, threshold);

    // ---- Re-validate, and revert anything that makes the page worse -------
    const accepted = fields.filter((f) => f.written);
    if (accepted.length > 0) {
      const merged = { ...extracted.data, ...patchOf(accepted) };
      const after = await validator.validate(
        merged,
        schemaSet,
        extracted.lineFor,
        extracted.colFor,
      );
      const broken = new Set(
        after.map((e) => topKey(e.instancePath)).filter((k) => k !== ""),
      );
      for (const f of accepted) {
        if (broken.has(keyOf(f))) {
          f.written = false;
          f.skipReason = "schema-mismatch";
          delete f.value;
        }
      }
    }

    const writable = fields.filter((f) => f.written);
    if (writable.length === 0) {
      return {
        file: label,
        format: extractor.name,
        schemas: schemaSet,
        fields,
        changed: false,
        ...(opts.includeContent ? { content } : {}),
      };
    }

    let next: string;
    try {
      next = extractor.apply(content, patchOf(writable), {
        filePath: label,
      });
    } catch (err) {
      return errorResult(
        label,
        extractor.name,
        (err as Error).message,
        schemaSet,
        fields,
      );
    }

    const changed = next !== content;
    if (changed && !dryRun && label !== "<stdin>") {
      await writeFileAtomic(resolve(base, label), next);
    }
    return {
      file: label,
      format: extractor.name,
      schemas: schemaSet,
      fields,
      changed,
      ...(opts.includeContent ? { content: next } : {}),
    };
  };

  // ---- Drive ---------------------------------------------------------------
  const results: FillFileResult[] = [];
  if (usingStdin) {
    results.push(
      await processOne(
        "<stdin>",
        opts.stdinContent ?? "",
        forcedExtractor?.extensions[0] ?? "",
      ),
    );
  }

  // Files are inferred in parallel — one network round trip each would make a
  // large retrofit unusable in series — but collected by index so the report is
  // deterministic regardless of completion order.
  const fileResults = await mapConcurrent(files, concurrency, async (file) => {
    const content = await readFile(resolve(base, file), "utf8");
    return processOne(file, content, extname(file));
  });
  results.push(...fileResults);

  return {
    results,
    summary: summarize(results, costUsd, cachedCount),
    threshold,
    dryRun,
    provider: identity.provider,
    model: identity.model,
    budgetExhausted,
  };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** First pointer segment of an Ajv instancePath ("/tags/0" -> "tags"). */
function topKey(instancePath: string): string {
  if (instancePath === "") return "";
  const seg = instancePath.slice(1).split("/")[0] ?? "";
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

const keyOf = (f: FilledField): string => f.field.slice(1);

function patchOf(fields: FilledField[]): MetadataPatch {
  const patch: MetadataPatch = {};
  for (const f of fields) patch[keyOf(f)] = f.value;
  return patch;
}

/**
 * A property is a candidate when it is absent from the metadata, or present but
 * invalid.
 *
 * "Missing" is derived from the schema objects rather than from validation
 * errors on purpose: Ajv reports a `required` violation with an empty
 * `instancePath` and names the property only inside the message text, so
 * recovering the key would mean parsing prose.
 *
 * When several schemas in the set define the same property, their subschemas
 * are **merged**, not raced. Picking one — the first named, say — would make the
 * proposal depend on flag order: stack a vocabulary that pins `type` to an enum
 * with OKF, which accepts any non-empty string, and whichever came first would
 * decide whether the model ever saw the enum. Since `validate` always runs every
 * schema, a value that only satisfies one of them was never writable anyway.
 */
export function collectCandidates(
  schemas: Record<string, unknown>[],
  data: Record<string, unknown>,
  errors: FieldError[],
  only?: Set<string>,
): Candidate[] {
  const invalid = new Set(
    errors.map((e) => topKey(e.instancePath)).filter((k) => k !== ""),
  );
  const required = new Set<string>();
  for (const schema of schemas) {
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) if (typeof r === "string") required.add(r);
    }
  }

  // Two schemas may define `#/$defs/Slug` differently, and the envelope has room
  // for only one of each name. Renaming the losers keeps each lifted subschema
  // pointing at its own definition.
  const { renames } = plannedFor(schemas);

  const seen = new Map<string, Candidate>();
  for (const [index, schema] of schemas.entries()) {
    const properties = schema.properties;
    if (typeof properties !== "object" || properties === null) continue;
    const renamed = renames.get(index);
    for (const [key, raw] of Object.entries(
      properties as Record<string, unknown>,
    )) {
      // `$schema` is docmeta's schema wiring, not document metadata.
      if (key === FILE_SCHEMA_KEY) continue;
      if (only && !only.has(key)) continue;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;

      const present = Object.prototype.hasOwnProperty.call(data, key);
      if (present && !invalid.has(key)) continue; // already valid — leave it alone

      const sub = renamed
        ? withRenamedRefs(raw as Record<string, unknown>, renamed)
        : (raw as Record<string, unknown>);
      const already = seen.get(key);
      if (already) {
        already.subschema = mergeSubschemas(already.subschema, sub);
        continue;
      }
      seen.set(key, {
        key,
        subschema: sub,
        required: required.has(key),
        present,
      });
    }
  }
  return [...seen.values()];
}

/**
 * Combine two subschemas for one property into a single schema that satisfies
 * both, via `allOf`.
 *
 * `allOf` rather than a structural merge because it is the only combination that
 * is correct for every keyword pair without knowing what the keywords mean: two
 * `enum`s intersect, two `minLength`s take the maximum, two `pattern`s must both
 * match. Ajv already resolves all of that, and the envelope schema built around
 * the result is compiled by Ajv before any proposal is accepted.
 *
 * Two things are done on top of the bare wrapper. Identical branches are dropped,
 * so the common "both schemas say `{type: "string"}`" case still lifts a plain
 * subschema. And the `description`s are combined and carried to the outside,
 * because that is where `fill-prompt` looks when it tells the model what the
 * property is for. Keeping only one of them would leave the prompt — and so the
 * proposal — dependent on schema order, which is the whole point of merging; the
 * combined text is deduplicated and sorted so it reads the same either way.
 */
function mergeSubschemas(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const branches: Record<string, unknown>[] = [];
  for (const part of [...branchesOf(a), ...branchesOf(b)]) {
    if (!branches.some((seen) => canonical(seen) === canonical(part))) {
      branches.push(part);
    }
  }
  const joined = joinDescriptions([...describedBy(a), ...describedBy(b)]);
  const description = joined === "" ? undefined : joined;

  const [first] = branches;
  if (branches.length === 1 && first !== undefined) {
    return description === undefined || first.description === description
      ? first
      : { ...first, description };
  }
  return {
    ...(description !== undefined ? { description } : {}),
    allOf: branches,
  };
}

/** How descriptions from different schemas are strung together for the prompt. */
const DESCRIPTION_JOIN = " ";

/** Deduplicate, drop blanks, and order by text so the result is order-free. */
function joinDescriptions(parts: string[]): string {
  return [...new Set(parts.map((p) => p.trim()))]
    .filter((p) => p !== "")
    .sort()
    .join(DESCRIPTION_JOIN);
}

/**
 * Every distinct sentence describing a subschema, including the ones on the
 * branches of an `allOf`.
 *
 * A wrapper this module built already carries exactly the join of its branches'
 * descriptions, so re-collecting it would fold the joined text back in as a
 * phrase of its own and make a third merge repeat itself. An author's wrapper
 * carries prose that is nowhere else, which is why the two are told apart by
 * comparison rather than by assuming the wrapper is ours.
 */
function describedBy(schema: Record<string, unknown>): string[] {
  const own =
    typeof schema.description === "string" ? schema.description : undefined;
  const branches = branchesOf(schema);
  if (branches.length === 1 && branches[0] === schema) {
    return own === undefined ? [] : [own];
  }
  const nested = branches.flatMap(describedBy);
  if (own !== undefined && own !== joinDescriptions(nested)) nested.push(own);
  return nested;
}

/**
 * The branches a subschema contributes to a merge — its own `allOf` entries if
 * it is a wrapper, otherwise itself. An author-written `{description, allOf}` is
 * unfolded on the same terms as one of ours; `describedBy` is what keeps its
 * description from being lost in the process.
 *
 * The unwrapping is deliberately narrow: an author-written schema may carry
 * `allOf` *alongside* other keywords, and flattening that would drop them.
 */
function branchesOf(schema: Record<string, unknown>): Record<string, unknown>[] {
  const keys = Object.keys(schema);
  const isWrapper =
    Array.isArray(schema.allOf) &&
    keys.every((k) => k === "allOf" || k === "description");
  if (!isWrapper) return [schema];
  return (schema.allOf as unknown[]).flatMap((branch) => {
    if (typeof branch === "object" && branch !== null && !Array.isArray(branch)) {
      return [branch as Record<string, unknown>];
    }
    // JSON Schema allows a boolean where a schema belongs. `true` constrains
    // nothing and disappears into the merge; `false` accepts nothing, and
    // dropping it would quietly turn a property nothing can satisfy into one
    // `fill` proposes for. `{not: {}}` says "never valid" in object form.
    return branch === false ? [{ not: {} }] : [];
  });
}

/** Key-order-independent serialization, so equal branches compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  // A schema parsed from JSON holds nothing `JSON.stringify` refuses, but
  // `collectCandidates` is public API and a hand-written JS object can pass an
  // `undefined`, a function, or a symbol. Tagging by type keeps those apart from
  // each other and from `null`, which is a legitimate schema value.
  return JSON.stringify(value) ?? `(${typeof value})`;
}

const DEF_BLOCKS = ["$defs", "definitions"] as const;
type DefBlock = (typeof DEF_BLOCKS)[number];

interface DefsPlan {
  defs: Record<DefBlock, Record<string, unknown>>;
  /** Schema index -> `"<block>/<name>"` -> the name that schema's defs got. */
  renames: Map<number, Map<string, string>>;
}

/**
 * Decide what the envelope's `$defs`/`definitions` blocks hold, and which
 * schemas need their `$ref`s pointed somewhere else to get there.
 *
 * The envelope is one document, so the two blocks are flat namespaces that every
 * schema in the set shares. Names collide: `Slug` in a house schema and `Slug` in
 * a vocabulary are unrelated definitions, and letting the first one win would
 * silently validate half the set against the wrong rule. A colliding definition
 * therefore gets its own name, and everything that pointed at it — the lifted
 * subschemas *and* the other definitions of the same schema — is rewritten to
 * match. That second part is why names are allocated for the whole set before
 * anything is rewritten: a definition may point at one that is renamed later in
 * the walk, and a pointer left behind resolves to another schema's rule.
 *
 * Definitions two schemas write identically share a slot, since there is nothing
 * to tell apart and a copy would only make the envelope noisier. That is settled
 * on the text alone, so it is offered only to definitions that resolve to
 * nothing else: `{$ref: "#/$defs/Inner"}` reads the same in both schemas while
 * meaning whatever each one's `Inner` says.
 *
 * The two blocks are kept **separate**: draft-07 schemas (which `dialectOf` in
 * validator.ts explicitly supports) write `$ref: "#/definitions/X"`, and folding
 * those entries into `$defs` would leave the pointer dangling.
 */
function planDefs(schemas: Record<string, unknown>[]): DefsPlan {
  const defs: Record<DefBlock, Record<string, unknown>> = {
    $defs: {},
    definitions: {},
  };
  const renames = new Map<number, Map<string, string>>();
  const placed: { index: number; block: DefBlock; emitted: string }[] = [];

  for (const [index, schema] of schemas.entries()) {
    for (const block of DEF_BLOCKS) {
      const entries = schema[block];
      if (typeof entries !== "object" || entries === null) continue;
      for (const [name, value] of Object.entries(
        entries as Record<string, unknown>,
      )) {
        const taken = defs[block];
        if (!(name in taken)) {
          taken[name] = value;
          placed.push({ index, block, emitted: name });
          continue;
        }
        if (!pointsInward(value) && canonical(taken[name]) === canonical(value)) {
          continue;
        }

        let emitted = `${name}__${index}`;
        while (emitted in taken) emitted += "_";
        taken[emitted] = value;
        placed.push({ index, block, emitted });
        let map = renames.get(index);
        if (!map) {
          map = new Map();
          renames.set(index, map);
        }
        map.set(`${block}/${name}`, emitted);
      }
    }
  }

  // Now that every name is settled, point each definition at the ones belonging
  // to the schema it came from.
  for (const { index, block, emitted } of placed) {
    const map = renames.get(index);
    if (map) defs[block][emitted] = withRenamedRefs(defs[block][emitted], map);
  }
  return { defs, renames };
}

/**
 * Every keyword that can send a definition back into its own document.
 * `$dynamicRef` (2020-12) and `$recursiveRef` (2019-09) resolve against the
 * schema they were written in just as `$ref` does, so a definition using one is
 * no more interchangeable between schemas than a `$ref` chain is.
 */
const INWARD_REFS = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);

/** Whether a definition depends on some other part of its own document. */
function pointsInward(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(pointsInward);
  if (typeof node !== "object" || node === null) return false;
  return Object.entries(node).some(([key, value]) =>
    INWARD_REFS.has(key) && typeof value === "string"
      ? value.startsWith("#")
      : pointsInward(value),
  );
}

/**
 * Carry `$defs`/`definitions` across so a lifted subschema's `$ref` resolves.
 *
 * Memoized on the array itself: `collectCandidates` needs the same plan to know
 * which refs to rewrite, and both are handed the one array `processOne` built
 * for the file.
 */
export function collectDefs(schemas: Record<string, unknown>[]): {
  $defs: Record<string, unknown>;
  definitions: Record<string, unknown>;
} {
  return plannedFor(schemas).defs;
}

const planCache = new WeakMap<Record<string, unknown>[], DefsPlan>();

function plannedFor(schemas: Record<string, unknown>[]): DefsPlan {
  let plan = planCache.get(schemas);
  if (!plan) {
    plan = planDefs(schemas);
    planCache.set(schemas, plan);
  }
  return plan;
}

/**
 * Deep-copy a subschema with its local `$ref`s repointed at the names its
 * definitions were emitted under. Only called for schemas that actually lost a
 * name collision, so the ordinary case keeps the original object.
 */
function withRenamedRefs<T>(node: T, renames: Map<string, string>): T {
  if (Array.isArray(node)) {
    return node.map((item) => withRenamedRefs(item, renames)) as T;
  }
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] =
      key === "$ref" && typeof value === "string"
        ? renameRef(value, renames)
        : withRenamedRefs(value, renames);
  }
  return out as T;
}

/**
 * Repoint one local pointer: `#/$defs/Slug` and `#/$defs/Slug/properties/x` both
 * follow the rename of `Slug`. Anything else — an absolute URI, a `$id`-relative
 * ref, a pointer into some other part of the document — is left alone.
 */
function renameRef(ref: string, renames: Map<string, string>): string {
  const match = /^#\/(\$defs|definitions)\/([^/]+)(\/.*)?$/.exec(ref);
  const block = match?.[1];
  const name = match?.[2];
  if (block === undefined || name === undefined) return ref;
  const emitted = renames.get(`${block}/${unescapePointer(name)}`);
  if (emitted === undefined) return ref;
  return `#/${block}/${escapePointer(emitted)}${match?.[3] ?? ""}`;
}

const unescapePointer = (segment: string): string =>
  segment.replace(/~1/g, "/").replace(/~0/g, "~");

const escapePointer = (name: string): string =>
  name.replace(/~/g, "~0").replace(/\//g, "~1");

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

function gate(
  candidates: Candidate[],
  proposals: ProposalSet,
  threshold: number,
): FilledField[] {
  return candidates.map((c): FilledField => {
    const proposal: Proposal | undefined = proposals[c.key];
    if (proposal == null) {
      return {
        field: `/${c.key}`,
        required: c.required,
        confidence: 0,
        reasoning: "",
        written: false,
        skipReason: "no-proposal",
      };
    }
    const passes = proposal.confidence >= threshold;
    return {
      field: `/${c.key}`,
      required: c.required,
      confidence: proposal.confidence,
      reasoning: proposal.reasoning,
      written: passes,
      ...(passes ? { value: proposal.value } : { skipReason: "low-confidence" as const }),
    };
  });
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/**
 * `schemas` is passed once resolution has succeeded, so a JSON consumer can
 * tell "the schema set was never resolved" from "it resolved and then writing
 * was refused" — the two need different follow-up.
 */
function errorResult(
  file: string,
  format: string,
  message: string,
  schemas: string[] = [],
  fields: FilledField[] = [],
): FillFileResult {
  return { file, format, schemas, fields, changed: false, error: message };
}

/**
 * Range-check a numeric option. Every comparison against NaN is false, so the
 * finite check has to be explicit or garbage passes silently.
 */
function requireNumber(
  value: number,
  name: string,
  bounds: { min: number; max: number; integer?: boolean },
): number {
  const { min, max, integer } = bounds;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new DocmetaError(
      `fill: "${name}" must be a number between ${min} and ${max}, got ${String(value)}.`,
    );
  }
  if (integer === true && !Number.isInteger(value)) {
    throw new DocmetaError(
      `fill: "${name}" must be a whole number, got ${String(value)}.`,
    );
  }
  return value;
}

/**
 * Provider names the inference layer accepts, taken from the library rather
 * than copied. A hardcoded list here silently went stale when `llama-cpp` was
 * added upstream; deriving it means a new provider works the day it ships.
 */
const PROVIDERS = new Set<string>([...Object.keys(DEFAULT_MODELS), "auto"]);

function assertKnownProvider(name: string): void {
  if (PROVIDERS.has(name)) return;
  throw new DocmetaError(
    `Unknown provider "${name}". Available: ${[...PROVIDERS].join(", ")}.`,
  );
}

/**
 * A model name belongs to exactly one provider, so it cannot be handed to
 * whichever provider detection picks: `--model gpt-4o-mini` on a machine with an
 * Anthropic key selected anthropic and then 404'd mid-run, after file discovery
 * had already been paid for.
 *
 * The library enforces this too. It is repeated here to name the flags rather
 * than the API fields, since that is what the user typed.
 *
 * `name` is the EFFECTIVE provider, so a `fill.provider` in config satisfies
 * this just as `--provider` does; only an unresolved `auto` is ambiguous.
 */
function assertModelHasProvider(
  name: ProviderSelector,
  model: string | undefined,
): void {
  if (name !== "auto" || model == null) return;
  throw new DocmetaError(
    `Model "${model}" was given without a provider: a model name does not say ` +
      `which provider owns it. Set --provider or fill.provider to one of ` +
      `${Object.keys(DEFAULT_MODELS).join(", ")}, or drop the model to take the ` +
      `detected provider's default.`,
  );
}

async function resolveIdentity(spec: {
  provider: ProviderSelector;
  model: string | null;
}): Promise<{ provider: ProviderName; model: string }> {
  try {
    return await resolveProviderIdentityAsync(spec);
  } catch (err) {
    // Detection failing with nothing available is operational, not per-file:
    // the aggregate message names every provider it tried and why each was out.
    throw new DocmetaError(
      err instanceof InferenceError
        ? err.message
        : `Could not resolve provider "${spec.provider}": ${(err as Error).message}`,
    );
  }
}

function summarize(
  results: FillFileResult[],
  costUsd: number,
  cached: number,
): FillRun["summary"] {
  let written = 0;
  let skipped = 0;
  let requiredSkipped = 0;
  for (const r of results) {
    for (const f of r.fields) {
      if (f.written) written++;
      else {
        skipped++;
        if (f.required) requiredSkipped++;
      }
    }
  }
  return {
    files: results.length,
    changed: results.filter((r) => r.changed).length,
    written,
    skipped,
    requiredSkipped,
    errors: results.filter((r) => r.error != null).length,
    costUsd,
    cached,
  };
}

/** Bounded worker pool that preserves input order in its output. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const i = next++;
        const item = items[i];
        if (i >= items.length || item === undefined) return;
        out[i] = await fn(item);
      }
    },
  );
  await Promise.all(workers);
  return out;
}
