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
