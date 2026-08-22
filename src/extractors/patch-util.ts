/**
 * Helpers shared by every `apply` implementation.
 *
 * These began as private functions in `frontmatter-write.ts`. They moved here
 * when HTML and XML gained write support, because a second copy of `deepEqual`
 * is a second chance for the verify step to disagree with itself — and a verify
 * step that quietly accepts what it should reject is worse than none.
 */
import type { MetadataPatch } from "../types.js";

/** Keys explicitly set to `undefined` mean "no opinion", not "set to null". */
export function dropUndefined(patch: MetadataPatch): MetadataPatch {
  const out: MetadataPatch = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return out;
}

/** Structural equality, used by every writer's verify-before-return step. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : NaN;
    const bt = b instanceof Date ? b.getTime() : NaN;
    return at === bt;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]),
  );
}
