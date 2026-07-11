import type { FhirVersion, JsonSchemaNode, TrimOptions } from "../types.js";

/**
 * Backend-neutral intermediate representation: a set of named,
 * JSON-Schema-shaped type definitions whose internal references use the
 * `#/definitions/<Name>` form (the convention of the official fhir.schema.json).
 * Both backends produce this shape; emitters consume it.
 */
export interface DefinitionRegistry {
  fhirVersion: FhirVersion;
  definitions: Map<string, JsonSchemaNode>;
  /** Concrete (non-abstract) resource type names, e.g. "Patient". */
  resourceNames: string[];
}

const REF_PREFIX = "#/definitions/";

export function refName(ref: string): string | undefined {
  return ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : undefined;
}

/** Collects the names of all `#/definitions/...` references inside a schema node. */
export function collectRefs(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        const name = refName(value);
        if (name) out.add(name);
      } else {
        collectRefs(value, out);
      }
    }
  }
  return out;
}

export interface ClosureResult {
  /** Definition name -> schema, for the full dependency closure of the roots. */
  schemas: Map<string, JsonSchemaNode>;
  /** Names whose bodies were replaced by generic-object stubs via trimming. */
  stubbed: Set<string>;
}

function stubSchema(reason: string): JsonSchemaNode {
  return {
    type: "object",
    additionalProperties: true,
    description: reason,
  };
}

/**
 * `ResourceList` in fhir.schema.json is a oneOf over every resource type
 * (150-200 entries), referenced by e.g. `Bundle.entry.resource` and
 * `DomainResource.contained`. Following it verbatim would drag the entire
 * specification into every output, so it is narrowed to the resource types
 * actually requested (plus Bundle/OperationOutcome, which the generated REST
 * paths always use).
 */
function narrowedResourceList(included: string[]): JsonSchemaNode {
  return {
    oneOf: included.map((name) => ({ $ref: `${REF_PREFIX}${name}` })),
    description:
      "A contained/bundled FHIR resource. Narrowed by fhir-openapi-translator to the " +
      "resource types requested at generation time; servers may return other types.",
  };
}

/**
 * Extracts the transitive dependency closure of `roots` from the registry via
 * breadth-first search. Cycles are fine: every definition is visited once and
 * mutual references remain as $refs. Trim options replace selected
 * definitions with stubs whose dependencies are not followed.
 */
export function extractClosure(
  registry: DefinitionRegistry,
  roots: string[],
  trim: TrimOptions = {},
  resourceListNarrowing: string[] = roots,
): ClosureResult {
  const schemas = new Map<string, JsonSchemaNode>();
  const stubbed = new Set<string>();
  const maxDepth = trim.maxDepth;

  let frontier = [...new Set(roots)];
  let depth = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const name of frontier) {
      if (schemas.has(name)) continue;
      const original = registry.definitions.get(name);
      if (!original) {
        throw new Error(`Unknown FHIR definition: ${name}`);
      }

      let schema: JsonSchemaNode = original;
      let followDeps = true;
      if (trim.excludeNarrative && name === "Narrative") {
        schema = stubSchema(
          "Human-readable narrative. Excluded from this specification (--exclude-narrative).",
        );
        followDeps = false;
        stubbed.add(name);
      } else if (maxDepth !== undefined && depth > maxDepth) {
        schema = stubSchema(
          `FHIR ${name}. Pruned from this specification by --max-depth ${maxDepth}.`,
        );
        followDeps = false;
        stubbed.add(name);
      } else if (name === "ResourceList") {
        schema = narrowedResourceList(
          [...new Set(resourceListNarrowing)].filter((n) => registry.definitions.has(n)),
        );
      }

      schemas.set(name, schema);
      if (followDeps) {
        for (const dep of collectRefs(schema)) {
          if (!schemas.has(dep)) next.push(dep);
        }
      }
    }
    frontier = next;
    depth++;
  }

  return { schemas, stubbed };
}
