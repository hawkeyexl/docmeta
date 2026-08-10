import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  listBuiltins,
  classifyRef,
  loadSchema,
} from "../src/core/schema-registry.js";
import { DocmetaError } from "../src/types.js";
import { startSchemaServer, type SchemaServer } from "./helpers/schema-server.js";

const here = dirname(fileURLToPath(import.meta.url));

const URL_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["type"],
};

describe("schema registry", () => {
  it("lists every built-in", () => {
    const ids = listBuiltins().map((b) => b.id);
    expect(ids).toContain("google:okf:0.1");
    expect(ids).toContain("diataxis:diataxis:1.0");
    expect(ids).toContain("passo-uno:seven-action:1.0");
    expect(ids).toContain("tgdp:templates:1.0");
  });

  it("classifies a built-in id", () => {
    expect(classifyRef("google:okf:0.1").kind).toBe("builtin");
    // A hyphenated vendor segment must still classify as a built-in, not a file.
    expect(classifyRef("passo-uno:seven-action:1.0").kind).toBe("builtin");
  });

  it("loads the taxonomy built-ins, keyed on their own property", async () => {
    const diataxis = await loadSchema("diataxis:diataxis:1.0");
    expect(
      (diataxis as { properties?: Record<string, unknown> }).properties,
    ).toHaveProperty("type");

    const sevenAction = await loadSchema("passo-uno:seven-action:1.0");
    expect(
      (sevenAction as { properties?: Record<string, unknown> }).properties,
    ).toHaveProperty("action");

    const tgdp = await loadSchema("tgdp:templates:1.0");
    expect(
      (tgdp as { properties?: Record<string, unknown> }).properties,
    ).toHaveProperty("type");
  });

  it("does not require a key on any taxonomy schema", async () => {
    for (const id of [
      "diataxis:diataxis:1.0",
      "passo-uno:seven-action:1.0",
      "tgdp:templates:1.0",
    ]) {
      const schema = await loadSchema(id);
      expect((schema as { required?: string[] }).required, id).toBeUndefined();
    }
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

describe("loadSchema over http(s)", () => {
  let server: SchemaServer;

  beforeAll(async () => {
    server = await startSchemaServer({
      "/ok.json": { json: URL_SCHEMA },
      "/cached.json": { json: URL_SCHEMA },
      "/notjson.json": { body: "<html>nope</html>", contentType: "text/html" },
      "/slow.json": { json: URL_SCHEMA, delayMs: 500 },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("fetches and returns the schema object", async () => {
    const schema = await loadSchema(`${server.url}/ok.json`);
    expect((schema as { required?: string[] }).required).toEqual(["type"]);
  });

  it("caches the URL — a second load does not hit the server again", async () => {
    const ref = `${server.url}/cached.json`;
    await loadSchema(ref);
    await loadSchema(ref);
    expect(server.hits("/cached.json")).toBe(1);
  });

  it("errors on a non-2xx response", async () => {
    await expect(loadSchema(`${server.url}/missing.json`)).rejects.toThrow(
      DocmetaError,
    );
    await expect(loadSchema(`${server.url}/missing.json`)).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it("errors on a non-JSON body", async () => {
    await expect(loadSchema(`${server.url}/notjson.json`)).rejects.toThrow(
      DocmetaError,
    );
    await expect(loadSchema(`${server.url}/notjson.json`)).rejects.toThrow(
      /JSON/,
    );
  });

  it("errors when the request exceeds the timeout", async () => {
    await expect(
      loadSchema(`${server.url}/slow.json`, { timeoutMs: 50 }),
    ).rejects.toThrow(DocmetaError);
    await expect(
      loadSchema(`${server.url}/slow.json`, { timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/i);
  });
});
