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
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
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
import { loadSchema } from "./schema-registry.js";
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
  if (meta.includes("draft-07") || meta.includes("draft/7")) return "draft7";
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
  return ajv;
}

export class Validator {
  private ajvByDialect = new Map<Dialect, InstanceType<AjvCtor>>();
  private cache = new Map<string, ValidateFunction>();

  private ajvFor(dialect: Dialect): InstanceType<AjvCtor> {
    let ajv = this.ajvByDialect.get(dialect);
    if (!ajv) {
      ajv = buildAjv(dialect);
      this.ajvByDialect.set(dialect, ajv);
    }
    return ajv;
  }

  private async compile(ref: string): Promise<ValidateFunction> {
    const cached = this.cache.get(ref);
    if (cached) return cached;
    const schema = await loadSchema(ref);
    let fn: ValidateFunction;
    try {
      fn = this.ajvFor(dialectOf(schema)).compile(schema);
    } catch (err) {
      throw new DocmetaError(
        `Schema "${ref}" failed to compile: ${(err as Error).message}`,
      );
    }
    this.cache.set(ref, fn);
    return fn;
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

function toFieldError(
  schema: string,
  e: ErrorObject,
  lineFor: (pointer: string) => number | undefined,
): FieldError {
  const instancePath = e.instancePath;
  // For `required`, point at the parent object but name the missing property.
  let message = e.message ?? "is invalid";
  if (e.keyword === "required" && e.params && "missingProperty" in e.params) {
    message = `must have required property '${String(e.params.missingProperty)}'`;
  } else if (
    e.keyword === "additionalProperties" &&
    e.params &&
    "additionalProperty" in e.params
  ) {
    message = `must NOT have additional property '${String(e.params.additionalProperty)}'`;
  }
  const line = lineFor(instancePath);
  return { schema, instancePath, message, ...(line != null ? { line } : {}) };
}
