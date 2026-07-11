import type { JsonSchemaNode, OpenApiVersion } from "../types.js";

const DEFINITIONS_REF = "#/definitions/";
const COMPONENTS_REF = "#/components/schemas/";

/**
 * Converts one JSON-Schema-shaped definition (draft-06 subset as used by
 * fhir.schema.json) into an OpenAPI schema object:
 *  - rewrites `#/definitions/X` refs to `#/components/schemas/X`
 *  - strips `pattern` from non-string types (fhir.schema.json puts regex
 *    patterns on booleans/numbers, where the keyword is meaningless)
 *  - drops JSON Schema bookkeeping keywords ($schema, id/$id, $comment)
 *  - for 3.0.x, downconverts `const` to a single-value `enum`
 */
export function convertSchema(node: JsonSchemaNode, target: OpenApiVersion): JsonSchemaNode {
  return convertNode(node, target) as JsonSchemaNode;
}

function convertNode(node: unknown, target: OpenApiVersion): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => convertNode(item, target));
  }
  if (!node || typeof node !== "object") return node;

  const out: JsonSchemaNode = {};
  const source = node as JsonSchemaNode;
  for (const [key, value] of Object.entries(source)) {
    switch (key) {
      case "$schema":
      case "$comment":
      case "id":
      case "$id":
        break;
      case "$ref":
        out.$ref =
          typeof value === "string" && value.startsWith(DEFINITIONS_REF)
            ? COMPONENTS_REF + value.slice(DEFINITIONS_REF.length)
            : value;
        break;
      case "const":
        if (target === "3.1.0") out.const = value;
        else out.enum = [value];
        break;
      case "pattern":
        if (source.type === undefined || source.type === "string") out.pattern = value;
        break;
      default:
        out[key] = convertNode(value, target);
    }
  }
  return out;
}
