/**
 * JSON Schema validation engine. Compiles and caches an Ajv validator per
 * schema reference, validates extracted metadata against each schema in a set,
 * and maps every violation to a {schema, instancePath, line} FieldError.
 */
import * as AjvDraft07Ns from "ajv";
import * as Ajv2019Ns from "ajv/dist/2019.js";
import * as Ajv2020Ns from "ajv/dist/2020.js";
import * as AjvDraft04Ns from "ajv-draft-04";
import * as addFormatsNs from "ajv-formats";
import { createRequire } from "node:module";
import type {
  DefinedError,
  ErrorObject,
  ValidateFunction,
} from "ajv/dist/2020.js";
import { DocmetaError, type FieldError } from "../types.js";

// ajv ships its meta-schema refs as JSON. A static JSON import survives
// bundling as a bare ESM import without the required `type: json` attribute, so
// load it through `require` instead (ajv is an external dep at runtime).
const draft06MetaSchema = createRequire(import.meta.url)(
  "ajv/dist/refs/json-schema-draft-06.json",
) as Record<string, unknown>;

// ajv and ajv-formats are CommonJS with a default export; under NodeNext the
// callable/constructable value lives on `.default`. Cast through the named
// default types so tsc sees a constructor / callable. The per-dialect builds
// expose the same shape, so we treat them all as the 2020 constructor type.
type AjvCtor = typeof import("ajv/dist/2020.js").default;
const AjvDraft07 = AjvDraft07Ns.default as unknown as AjvCtor;
const Ajv2019 = Ajv2019Ns.default as unknown as AjvCtor;
const Ajv2020 = Ajv2020Ns.default as unknown as AjvCtor;
const AjvDraft04 = AjvDraft04Ns.default as unknown as AjvCtor;
const addFormats =
  addFormatsNs.default as unknown as typeof import("ajv-formats").default;
import {
  loadSchema,
  publishedBuiltins,
  type LoadSchemaOptions,
} from "./schema-registry.js";
import { FILE_SCHEMA_KEY } from "./resolve-schema.js";

type Dialect = "2020" | "2019" | "draft7" | "draft4";

/**
 * Pick a JSON Schema dialect from a schema's own `$schema` meta-schema URI.
 * Remote schemas commonly target draft-07/draft-04, which the 2020 build can't
 * compile, so each dialect gets its own Ajv. A missing or unrecognized
 * `$schema` falls back to 2020 (the dialect of the built-ins).
 */
function dialectOf(schema: Record<string, unknown>): Dialect {
  const meta = typeof schema.$schema === "string" ? schema.$schema : "";
  if (meta.includes("2019-09")) return "2019";
  // draft-06 shares the draft-07 build (its meta-schema is registered there).
  if (
    meta.includes("draft-07") ||
    meta.includes("draft/7") ||
    meta.includes("draft-06") ||
    meta.includes("draft/6")
  ) {
    return "draft7";
  }
  if (meta.includes("draft-04") || meta.includes("draft/4")) return "draft4";
  return "2020";
}

function buildAjv(dialect: Dialect): InstanceType<AjvCtor> {
  // strict: false so user-supplied schemas with lax metadata still compile.
  const opts = { allErrors: true, strict: false } as const;
  const ajv =
    dialect === "2019"
      ? new Ajv2019(opts)
      : dialect === "draft7"
        ? new AjvDraft07(opts)
        : dialect === "draft4"
          ? new AjvDraft04(opts)
          : new Ajv2020(opts);
  addFormats(ajv);
  // draft-06 shares the draft-07 build; register its meta-schema so draft-06
  // schemas compile too rather than erroring on an unknown `$schema`.
  if (dialect === "draft7") ajv.addMetaSchema(draft06MetaSchema);
  registerBuiltins(ajv, dialect);
  return ajv;
}

/**
 * Make every built-in resolvable as a `$ref` target, under both of its names.
 *
 * Ajv is constructed with no `loadSchema`, so before this a user's schema could
 * not `$ref` a built-in by **any** route — not the published URL (nothing to
 * fetch it with) and not the docmeta id either, even though the schema was
 * bundled and would later be compiled into this very instance. Both failed with
 * "can't resolve reference … from id #", which reads like the published file is
 * broken. Proposal 0009 stress test 5.
 *
 * Three mechanics that are easy to get wrong:
 *
 * - **One call per built-in.** `addSchema(schema, url)` registers under the key
 *   *and* under the schema's own `$id`, so the id form comes for free. Calling
 *   it a second time under the id throws "schema with key or id … already
 *   exists".
 * - **Meta-schema validation is off for these seven.** All the built-ins are
 *   2020-12, and the 2019/draft-07/draft-04 instances do not carry that
 *   meta-schema — `addSchema` would throw `no schema with key or ref
 *   "https://json-schema.org/draft/2020-12/schema"` and take out every Ajv but
 *   one. These are docmeta's own files, covered by their own tests, so skipping
 *   the check costs nothing. The flag is per call: a *user's* schema is still
 *   validated normally.
 * - **All four dialects, not just 2020.** `dialectOf` picks the instance from
 *   the *user's* `$schema`, so a draft-07 house schema extending OKF compiles in
 *   the draft-07 Ajv and needs the built-ins registered there too.
 *
 * Registration is lazy — Ajv compiles a stored schema only when something
 * references it — so this costs a map insert per built-in, not seven compiles.
 *
 * Called from `buildAjv` rather than from `Validator`, deliberately:
 * `compileWithFormats` builds its own throwaway instance for `fill`'s proposal
 * envelope, which lifts subschemas out of the user's schemas and would
 * otherwise lose every `$ref` into a built-in.
 */
function registerBuiltins(ajv: InstanceType<AjvCtor>, dialect: Dialect): void {
  for (const { id, url, schema } of publishedBuiltins()) {
    ajv.addSchema(schema, url, undefined, false);
    // draft-04 predates `$id` — `ajv-draft-04` reads `id` instead — so the URL
    // key is the only registration the call above produces there, and the id
    // form has to be added explicitly. It does not throw as a duplicate for the
    // same reason: `$id` was never registered.
    if (dialect === "draft4") ajv.addSchema(schema, id, undefined, false);
  }
}

/**
 * Compile an ad-hoc 2020-12 schema with docmeta's format support.
 *
 * `fill` needs this for the proposal envelope it builds around a document
 * schema's own property subschemas: those routinely carry `format: "date-time"`
 * / `"uri"`, and an Ajv without `ajv-formats` refuses to compile them outright.
 */
export function compileWithFormats(
  schema: Record<string, unknown>,
): ValidateFunction {
  return buildAjv("2020").compile(schema);
}

export class Validator {
  /**
   * How this validator's schemas are loaded: the disk cache location, its TTL,
   * and `--offline`. Held per instance rather than read from module state, so
   * two differently-configured validations in one process each get their own
   * settings.
   *
   * That is not full isolation, and the difference matters to a library
   * caller: `schema-registry` keeps a process-wide memo of fetched schemas, so
   * one validator's successful fetch is visible to another. `offline` is
   * excluded from that sharing on purpose — an offline validator will not be
   * served something this process pulled over the network — but the memo is
   * still shared, so a URL fetched once is not re-fetched per instance.
   */
  constructor(private readonly schemaOptions: LoadSchemaOptions = {}) {}

  private ajvByDialect = new Map<Dialect, InstanceType<AjvCtor>>();
  /**
   * Keyed on the in-flight *promise*, not the resolved validator. Caching the
   * result made this a check-then-act race: `fill` walks files through a worker
   * pool, so every worker missed the cache while the first `loadSchema` was
   * still pending and they all then compiled the same schema into the one
   * shared per-dialect Ajv. Ajv registers a schema's `$id` on the first compile
   * and rejects the second with "schema with key or id ... already exists",
   * which took down any multi-file run against an $id-bearing schema. Storing
   * the promise before the first await lets the losers await the one compile.
   */
  private cache = new Map<string, Promise<ValidateFunction>>();

  private ajvFor(dialect: Dialect): InstanceType<AjvCtor> {
    let ajv = this.ajvByDialect.get(dialect);
    if (!ajv) {
      ajv = buildAjv(dialect);
      this.ajvByDialect.set(dialect, ajv);
    }
    return ajv;
  }

  /**
   * Synchronous by design: the `cache.set` has to happen in the same tick as
   * the miss, or a second caller can slip in before the entry exists.
   */
  private compile(ref: string): Promise<ValidateFunction> {
    const cached = this.cache.get(ref);
    if (cached) return cached;
    const pending = this.compileUncached(ref);
    this.cache.set(ref, pending);
    // A failed load or compile is not cached — a transient fetch failure must
    // stay retryable rather than poisoning the ref for this Validator's life.
    // The extra `catch` keeps the eviction off the returned promise's chain, so
    // it does not convert the rejection into a handled one for the caller.
    pending.catch(() => {
      if (this.cache.get(ref) === pending) this.cache.delete(ref);
    });
    return pending;
  }

  private async compileUncached(ref: string): Promise<ValidateFunction> {
    const schema = await loadSchema(ref, this.schemaOptions);
    try {
      const ajv = this.ajvFor(dialectOf(schema));
      // This cache is keyed on the ref string, but Ajv's registry is keyed on
      // `$id` — so one schema named two ways (a published URL in a document's
      // `$schema`, a local path on the command line) misses the cache twice and
      // Ajv rejects the second compile as a duplicate id. Reuse the existing
      // registration instead. `$id` is the schema's identity as far as Ajv is
      // concerned, so if two refs claim the same one, sharing a validator is
      // the only reading available — the alternative is the hard error this
      // replaces.
      //
      // Reused only when the registration really is *this* object. Sharing on
      // the id alone was tolerable while a registration could only come from an
      // earlier compile in the same run. It stopped being tolerable when
      // `registerBuiltins` began pre-loading all seven built-ins into every
      // instance: an id collision is no longer a race whose outcome depends on
      // ordering, it is certain, and the built-in always wins.
      //
      // What that would silently override is a vendored built-in the user then
      // edited — the workflow proposal 0009 actively encourages. `schemas
      // vendor` writes a copy carrying `$id: google:okf:0.1`, so a house rule
      // added to that copy would simply not apply, while the report went on
      // naming the local path.
      //
      // A different schema claiming a taken id is compiled on its own merits,
      // with the id dropped from a shallow copy: Ajv refuses a second schema
      // under one id, and the id is not what identifies a schema here anyway —
      // the *ref* is what reports name, what baselines fingerprint, and what
      // this cache is keyed on.
      const id = typeof schema["$id"] === "string" ? schema["$id"] : undefined;
      const registered = id != null ? ajv.getSchema(id) : undefined;
      if (registered) {
        if (registered.schema === schema) return registered;
        const { $id: _taken, ...anonymous } = schema;
        return ajv.compile(anonymous);
      }
      return ajv.compile(schema);
    } catch (err) {
      throw new DocmetaError(
        `Schema "${ref}" failed to compile: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Validate `data` against every schema in `refs`. Returns all violations,
   * each tagged with the schema that produced it and a source line via
   * `lineFor`.
   */
  async validate(
    data: Record<string, unknown>,
    refs: string[],
    lineFor: (pointer: string) => number | undefined,
  ): Promise<FieldError[]> {
    // `$schema` is a docmeta directive, not part of the document's metadata —
    // strip it so schemas with additionalProperties:false don't flag it.
    const { [FILE_SCHEMA_KEY]: _omit, ...subject } = data;
    void _omit;

    const errors: FieldError[] = [];
    for (const ref of refs) {
      const fn = await this.compile(ref);
      const ok = fn(subject);
      if (ok) continue;
      for (const e of fn.errors ?? []) {
        errors.push(toFieldError(ref, e, lineFor));
      }
    }
    return errors;
  }
}

/**
 * The stable identifier inside a violation's `params`, when there is one.
 *
 * Only keywords whose parameter names a *thing* qualify. `pattern` carries the
 * regex source and `enum`/`minLength`/`minimum` carry schema-authored values:
 * including those would change a violation's identity every time the schema
 * author edited the rule, which is exactly what a baseline must survive.
 *
 * `DefinedError` is Ajv's own discriminated union over `keyword`, so each arm
 * below is type-checked against the real `params` shape rather than duck-typed.
 */
function subjectOf(e: DefinedError): string | undefined {
  switch (e.keyword) {
    case "required":
      return e.params.missingProperty;
    case "additionalProperties":
      return e.params.additionalProperty;
    case "format":
      return e.params.format;
    case "type":
      // A union schema (`"type": ["string", "null"]`) yields the comma-joined
      // `"string,null"` rather than a single name. That is stable, so it
      // fingerprints correctly — but anyone matching on `subject` downstream
      // should not assume one type per value.
      return e.params.type;
    default:
      return undefined;
  }
}

function toFieldError(
  schema: string,
  e: ErrorObject,
  lineFor: (pointer: string) => number | undefined,
): FieldError {
  // Ajv's documented way to narrow: every error it raises for a built-in
  // vocabulary is a member of `DefinedError`, but `ValidateFunction.errors` is
  // typed as the open `ErrorObject` to leave room for custom keywords.
  const defined = e as DefinedError;
  const instancePath = e.instancePath;
  const subject = subjectOf(defined);
  // For `required`, point at the parent object but name the missing property.
  let message = e.message ?? "is invalid";
  if (defined.keyword === "required") {
    message = `must have required property '${defined.params.missingProperty}'`;
  } else if (defined.keyword === "additionalProperties") {
    message = `must NOT have additional property '${defined.params.additionalProperty}'`;
  }
  const line = lineFor(instancePath);
  return {
    schema,
    instancePath,
    message,
    keyword: e.keyword,
    ...(subject != null ? { subject } : {}),
    ...(line != null ? { line } : {}),
  };
}
