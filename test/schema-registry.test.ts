import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  listBuiltins,
  classifyRef,
  loadSchema,
} from "../src/core/schema-registry.js";
import { DocmetaError } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("schema registry", () => {
  it("lists the OKF built-in", () => {
    const ids = listBuiltins().map((b) => b.id);
    expect(ids).toContain("google:okf:0.1");
  });

  it("classifies a built-in id", () => {
    expect(classifyRef("google:okf:0.1").kind).toBe("builtin");
  });

  it("classifies an http(s) url", () => {
    expect(classifyRef("https://example.com/s.json").kind).toBe("url");
  });

  it("classifies a local .json path (incl. Windows-style)", () => {
    expect(classifyRef("./schemas/x.json").kind).toBe("file");
    expect(classifyRef("schemas/x.json").kind).toBe("file");
    expect(classifyRef("C:\\schemas\\x.json").kind).toBe("file");
  });

  it("loads the OKF built-in schema object", async () => {
    const schema = await loadSchema("google:okf:0.1");
    expect((schema as { required?: string[] }).required).toEqual(["type"]);
  });

  it("errors on an unknown built-in id, listing available ones", async () => {
    await expect(loadSchema("google:nope:9.9")).rejects.toBeInstanceOf(
      DocmetaError,
    );
    await expect(loadSchema("google:nope:9.9")).rejects.toThrow(
      /google:okf:0\.1/,
    );
  });

  it("loads a schema from a local file path", async () => {
    const p = join(here, "fixtures", "extra.schema.json");
    const schema = await loadSchema(p);
    expect(schema).toBeTypeOf("object");
  });
});
