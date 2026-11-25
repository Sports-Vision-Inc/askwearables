// The SDK is checked against the OpenAPI document, and the document against the edge Worker's source.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openapi } from "../../../workers/edge/src/openapi.js";
import { generate } from "../codegen/generate.js";
import { AskWearables, OPERATIONS } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), "utf8");
const doc = JSON.parse(read("../../openapi.json"));

describe("OpenAPI", () => {
  it("sdks/openapi.json and the site copy match the edge Worker's openapi()", () => {
    const live = JSON.parse(JSON.stringify(openapi("api.askwearables.app")));
    expect(doc).toEqual(live);
    expect(JSON.parse(read("../../../workers/site/public/openapi.json"))).toEqual(live);
  });

  it("src/schema.ts is up to date with openapi.json (run `npm run generate`)", () => {
    expect(read("../src/schema.ts")).toBe(generate(doc));
  });

  it("every SDK operation exists in the document with the same method", () => {
    for (const [id, op] of Object.entries(OPERATIONS)) {
      const item = doc.paths[op.path];
      expect(item, op.path).toBeDefined();
      expect(item[op.method.toLowerCase()]?.operationId).toBe(id);
    }
  });

  it("the client has a method for each required operation", () => {
    const c = new AskWearables({ apiKey: "aw_dev_x", fetch: (async () => new Response("{}")) as typeof fetch });
    for (const m of ["ask", "query", "capabilities", "getPacket", "createUser", "createGrantLink", "ingest", "usage"] as const) {
      expect(typeof c[m]).toBe("function");
      expect(OPERATIONS[m]).toBeDefined();
    }
  });

  it("the operations that identify an agent carry signature headers in the document", () => {
    for (const id of ["ask", "query", "capabilities", "getPacket", "createGrantLink"] as const) expect(OPERATIONS[id].signed).toBe(true);
  });
});
