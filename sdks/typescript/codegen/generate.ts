// A small, dependency-free OpenAPI 3.1 -> TypeScript generator, sized for this API.
// It turns components.schemas, request bodies and 200 responses into types, and the paths into an
// operation table. Operation types are named <OperationId>RequestBody and <OperationId>ResponseBody. test/openapi.test.ts regenerates in memory and fails if src/schema.ts is stale.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = { [k: string]: Json };
interface Doc {
  paths: Record<string, Record<string, Schema>>;
  components: { schemas: Record<string, Schema> };
}

const HTTP = ["get", "post", "put", "patch", "delete"];
const pascal = (s: string) => s.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase());
const ident = (k: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));
const pad = (n: number) => "  ".repeat(n);

function doc(s: Schema, depth: number): string {
  const d = s.description;
  return typeof d === "string" ? `${pad(depth)}/** ${d.replace(/\*\//g, "*\\/")} */\n` : "";
}

function prim(t: string): string {
  switch (t) {
    case "integer":
    case "number": return "number";
    case "string": return "string";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": return "unknown[]";
    case "object": return "Record<string, unknown>";
    default: return "unknown";
  }
}

export function toTs(s: Schema | undefined, depth = 0): string {
  if (!s) return "unknown";
  if (typeof s.$ref === "string") return s.$ref.split("/").pop()!;
  if ("const" in s) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (Array.isArray(s.type)) return s.type.map((t) => prim(String(t))).join(" | ");
  if (s.type === "array") {
    const inner = toTs(s.items as Schema | undefined, depth);
    return /[|&]/.test(inner) ? `Array<${inner}>` : `${inner}[]`;
  }
  if (s.type === "object" || s.properties) {
    const props = s.properties as Record<string, Schema> | undefined;
    if (!props || !Object.keys(props).length) return "Record<string, unknown>";
    const req = new Set((s.required as string[] | undefined) ?? []);
    const lines = Object.entries(props).map(([k, v]) => `${doc(v, depth + 1)}${pad(depth + 1)}${ident(k)}${req.has(k) ? "" : "?"}: ${toTs(v, depth + 1)};`);
    return `{\n${lines.join("\n")}\n${pad(depth)}}`;
  }
  return prim(String(s.type ?? ""));
}

function declare(name: string, s: Schema | undefined): string {
  const t = toTs(s, 0);
  return t.startsWith("{\n") ? `export interface ${name} ${t}\n` : `export type ${name} = ${t};\n`;
}

export function generate(input: unknown): string {
  const d = input as Doc;
  const out: string[] = [
    "// Generated from sdks/openapi.json by codegen/run.ts. Do not edit by hand: run `npm run generate`.",
    "/* eslint-disable */",
    "",
  ];
  for (const [name, s] of Object.entries(d.components.schemas)) out.push(declare(name, s));

  const ops: string[] = [];
  for (const [path, item] of Object.entries(d.paths)) {
    for (const method of HTTP) {
      const op = item[method] as Schema | undefined;
      if (!op) continue;
      const id = String(op.operationId);
      const params = (op.parameters as Schema[] | undefined) ?? [];
      const signed = params.some((p) => p.name === "X-AskWearables-Signature");
      const userHeader = params.some((p) => p.name === "X-AskWearables-User");
      const body = (op.requestBody as Schema | undefined)?.content as Record<string, Schema> | undefined;
      const bodySchema = body?.["application/json"]?.schema as Schema | undefined;
      const ok = ((op.responses as Record<string, Schema>)["200"]?.content as Record<string, Schema> | undefined)?.["application/json"]?.schema as Schema | undefined;
      if (bodySchema) out.push(declare(`${pascal(id)}RequestBody`, bodySchema));
      out.push(declare(`${pascal(id)}ResponseBody`, ok));
      ops.push(`  ${id}: { method: ${JSON.stringify(method.toUpperCase())}, path: ${JSON.stringify(path)}, signed: ${signed}, userHeader: ${userHeader}, body: ${!!bodySchema} },`);
    }
  }
  out.push("/** Every operation in the OpenAPI document: method, path template, and whether it takes a signature and user header. */");
  out.push(`export const OPERATIONS = {\n${ops.join("\n")}\n} as const;\n`);
  out.push("export type OperationId = keyof typeof OPERATIONS;\n");
  return out.join("\n");
}
