import {
  loadOperationDefinitions,
  type MinOperationDefinition,
  type MinOperationParameter,
} from "./definitions.js";
import type { FhirVersion, JsonSchemaNode } from "./types.js";

const FHIR_JSON = "application/fhir+json";
const SCHEMAS = "#/components/schemas/";

/** FHIR primitive type names are lowercase-first; complex types are not. */
function isPrimitive(type: string | undefined): boolean {
  return !!type && type.charAt(0) === type.charAt(0).toLowerCase();
}

function camelCode(code: string): string {
  return code.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function ref(schema: string) {
  return { $ref: `${SCHEMAS}${schema}` };
}

function fhirContent(schema: string) {
  return { [FHIR_JSON]: { schema: ref(schema) } };
}

function errorResponses() {
  return {
    default: {
      description: "Error, with an OperationOutcome describing the problem",
      content: fhirContent("OperationOutcome"),
    },
  };
}

export interface OperationPathsResult {
  paths: Record<string, JsonSchemaNode>;
  /** Schema names the operations reference, to add to the closure roots. */
  extraSchemaRoots: string[];
}

/**
 * Emits paths for the standard FHIR operations applicable to one resource
 * type, from the vendored OperationDefinitions.
 *
 * Method selection is deterministic per operation: GET with query parameters
 * when every `in` parameter is a primitive type (the spec-legal simple
 * invocation, and how e.g. $everything is used in practice); otherwise POST
 * with a Parameters request body. System-level-only operations are not
 * resource-scoped and are out of scope here.
 */
export function buildOperationPaths(
  fhirVersion: FhirVersion,
  resource: string,
  knownResources: ReadonlySet<string>,
): OperationPathsResult {
  const paths: Record<string, JsonSchemaNode> = {};
  const extraSchemaRoots = new Set<string>();

  const applicable = loadOperationDefinitions(fhirVersion).filter(
    (op) =>
      (op.type || op.instance) &&
      (op.resource.includes(resource) || op.resource.includes("Resource")),
  );

  for (const op of applicable) {
    const inParams = op.parameters.filter((p) => p.use === "in");
    const useGet = inParams.every((p) => isPrimitive(p.type));
    const responseSchema = responseSchemaName(op, knownResources);
    extraSchemaRoots.add(responseSchema);
    if (!useGet) extraSchemaRoots.add("Parameters");

    const buildOperation = (level: "Type" | "Instance") => {
      const operation: JsonSchemaNode = {
        tags: [resource],
        summary: `$${op.code} (${level.toLowerCase()} level)`,
        ...(op.description ? { description: op.description } : {}),
        operationId: `${camelCode(op.code)}${resource}${level}`,
        externalDocs: { url: op.url },
        responses: {
          "200": {
            description: `Result of the $${op.code} operation`,
            content: fhirContent(responseSchema),
          },
          ...errorResponses(),
        },
      };
      if (useGet) {
        if (inParams.length > 0) operation.parameters = inParams.map(queryParameter);
      } else {
        operation.requestBody = {
          required: inParams.some((p) => p.min >= 1),
          content: fhirContent("Parameters"),
        };
      }
      return operation;
    };

    const method = useGet ? "get" : "post";
    if (op.type) {
      paths[`/${resource}/$${op.code}`] = { [method]: buildOperation("Type") };
    }
    if (op.instance) {
      paths[`/${resource}/{id}/$${op.code}`] = {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: `Logical id of the ${resource}`,
            schema: { type: "string", pattern: "^[A-Za-z0-9\\-\\.]{1,64}$" },
          },
        ],
        [method]: buildOperation("Instance"),
      };
    }
  }

  return { paths, extraSchemaRoots: [...extraSchemaRoots].sort() };
}

/**
 * Exactly one `out` parameter named `return` typed as a resource maps to that
 * resource; every other output shape is a Parameters resource.
 */
function responseSchemaName(
  op: MinOperationDefinition,
  knownResources: ReadonlySet<string>,
): string {
  const outParams = op.parameters.filter((p) => p.use === "out");
  if (outParams.length === 1) {
    const only = outParams[0]!;
    if (only.name === "return" && only.type && knownResources.has(only.type)) {
      return only.type;
    }
  }
  return "Parameters";
}

function queryParameter(param: MinOperationParameter): JsonSchemaNode {
  const isArray = param.max === "*" || Number(param.max) > 1;
  const base: JsonSchemaNode = { type: "string" };
  return {
    name: param.name,
    in: "query",
    required: param.min >= 1,
    ...(param.documentation ? { description: param.documentation } : {}),
    // FHIR primitives serialize as strings in URLs; the FHIR type is kept
    // as an extension, consistent with search parameters.
    schema: isArray ? { type: "array", items: base } : base,
    ...(isArray ? { explode: true } : {}),
    "x-fhir-type": param.type,
  };
}
