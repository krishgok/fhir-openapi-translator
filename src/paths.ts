import { loadSearchParameters } from "./definitions.js";
import type { FhirVersion, JsonSchemaNode } from "./types.js";

const FHIR_JSON = "application/fhir+json";
const SCHEMAS = "#/components/schemas/";
const PARAMETERS = "#/components/parameters/";

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

function idParameter(name: string, description: string) {
  return {
    name,
    in: "path",
    required: true,
    description,
    schema: { type: "string", pattern: "^[A-Za-z0-9\\-\\.]{1,64}$" },
  };
}

/**
 * Search parameters common to all resources plus the standard search result
 * parameters, emitted once under components/parameters and $ref'd from every
 * search operation. All are strings except _count: FHIR search values carry
 * prefixes/modifiers (e.g. `ge2020-01-01`, `:exact`), so stricter types would
 * reject valid requests.
 */
const COMMON_SEARCH_PARAMETERS: Record<string, { description: string; schema: JsonSchemaNode }> = {
  _id: { description: "Logical id of this artifact", schema: { type: "string" } },
  _lastUpdated: {
    description: "When the resource version last changed (supports date prefixes, e.g. ge2021-01-01)",
    schema: { type: "string" },
  },
  _tag: { description: "Tags applied to this resource", schema: { type: "string" } },
  _profile: { description: "Profiles this resource claims to conform to", schema: { type: "string" } },
  _security: { description: "Security labels applied to this resource", schema: { type: "string" } },
  _text: { description: "Search on the narrative of the resource", schema: { type: "string" } },
  _content: { description: "Search on the entire content of the resource", schema: { type: "string" } },
  _sort: { description: "Sort order of the results (comma-separated parameter names, '-' prefix for descending)", schema: { type: "string" } },
  _count: { description: "Maximum number of results per page", schema: { type: "integer", minimum: 0 } },
  _include: { description: "Include referenced resources in the results", schema: { type: "string" } },
  _revinclude: { description: "Include resources that reference the matches in the results", schema: { type: "string" } },
  _summary: {
    description: "Return only a portion of each resource",
    schema: { type: "string", enum: ["true", "text", "data", "count", "false"] },
  },
  _total: {
    description: "Requested precision of the Bundle.total",
    schema: { type: "string", enum: ["none", "estimate", "accurate"] },
  },
  _elements: { description: "Restrict returned elements (comma-separated element names)", schema: { type: "string" } },
};

export function commonSearchParameterComponents(): Record<string, JsonSchemaNode> {
  const out: Record<string, JsonSchemaNode> = {};
  for (const [name, { description, schema }] of Object.entries(COMMON_SEARCH_PARAMETERS)) {
    out[name] = { name, in: "query", required: false, description, schema };
  }
  return out;
}

/** FHIR RESTful interaction codes (CapabilityStatement.rest.resource.interaction). */
export type FhirInteraction =
  | "read"
  | "vread"
  | "update"
  | "patch"
  | "delete"
  | "history-instance"
  | "history-type"
  | "create"
  | "search-type";

export const ALL_INTERACTIONS: readonly FhirInteraction[] = [
  "read",
  "vread",
  "update",
  "patch",
  "delete",
  "history-instance",
  "history-type",
  "create",
  "search-type",
];

export interface ResourcePathOptions {
  /** Emit only these interactions. Default: all of them. */
  interactions?: ReadonlySet<FhirInteraction>;
  /**
   * Restrict resource-specific search parameters to these codes (the common
   * result parameters like `_id`/`_count` are always kept). Default: all
   * search parameters the FHIR version defines for the resource.
   */
  searchParamCodes?: ReadonlySet<string>;
}

function resourceSearchParameters(
  fhirVersion: FhirVersion,
  resource: string,
  only?: ReadonlySet<string>,
): JsonSchemaNode[] {
  return loadSearchParameters(fhirVersion)
    .filter((sp) => sp.base.includes(resource) && (!only || only.has(sp.code)))
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((sp) => ({
      name: sp.code,
      in: "query",
      required: false,
      description: sp.description,
      // FHIR search values carry prefixes and modifiers, so all are strings.
      schema: { type: "string" },
      "x-fhir-search-type": sp.type,
    }));
}

const historyParameters = () => [
  { $ref: `${PARAMETERS}_count` },
  {
    name: "_since",
    in: "query",
    required: false,
    description: "Only include versions created at or after this instant",
    schema: { type: "string", format: "date-time" },
  },
];

/**
 * FHIR RESTful API interactions for one resource type. By default every
 * standard interaction (search, create, read, vread, update, patch, delete,
 * and instance/type history) is emitted; `options.interactions` restricts the
 * set (e.g. from a CapabilityStatement), and empty path items are dropped.
 */
export function buildResourcePaths(
  fhirVersion: FhirVersion,
  resource: string,
  /** Schema referenced by request/response bodies; a profile name or the resource. */
  schemaName: string = resource,
  options: ResourcePathOptions = {},
): Record<string, JsonSchemaNode> {
  const want = (interaction: FhirInteraction) =>
    !options.interactions || options.interactions.has(interaction);
  const body = () => fhirContent(schemaName);
  const idParam = () => idParameter("id", `Logical id of the ${resource}`);
  const paths: Record<string, JsonSchemaNode> = {};

  const typeItem: Record<string, JsonSchemaNode> = {};
  if (want("search-type")) {
    typeItem.get = {
      tags: [resource],
      summary: `Search for ${resource} resources`,
      operationId: `search${resource}`,
      parameters: [
        ...Object.keys(COMMON_SEARCH_PARAMETERS).map((name) => ({ $ref: `${PARAMETERS}${name}` })),
        ...resourceSearchParameters(fhirVersion, resource, options.searchParamCodes),
      ],
      responses: {
        "200": {
          description: `Bundle of matching ${resource} resources`,
          content: fhirContent("Bundle"),
        },
        ...errorResponses(),
      },
    };
  }
  if (want("create")) {
    typeItem.post = {
      tags: [resource],
      summary: `Create a ${resource} resource`,
      operationId: `create${resource}`,
      requestBody: { required: true, content: body() },
      responses: {
        "201": { description: `${resource} created`, content: body() },
        ...errorResponses(),
      },
    };
  }
  if (Object.keys(typeItem).length > 0) paths[`/${resource}`] = typeItem;

  const instanceItem: Record<string, JsonSchemaNode> = {};
  if (want("read")) {
    instanceItem.get = {
      tags: [resource],
      summary: `Read a ${resource} resource by id`,
      operationId: `read${resource}`,
      responses: {
        "200": { description: `The ${resource} resource`, content: body() },
        ...errorResponses(),
      },
    };
  }
  if (want("update")) {
    instanceItem.put = {
      tags: [resource],
      summary: `Update (or create) a ${resource} resource by id`,
      operationId: `update${resource}`,
      parameters: [
        {
          name: "If-Match",
          in: "header",
          required: false,
          description: "Version-aware update: weak ETag of the version being updated",
          schema: { type: "string" },
        },
      ],
      requestBody: { required: true, content: body() },
      responses: {
        "200": { description: `${resource} updated`, content: body() },
        "201": { description: `${resource} created`, content: body() },
        ...errorResponses(),
      },
    };
  }
  if (want("patch")) {
    instanceItem.patch = {
      tags: [resource],
      summary: `Patch a ${resource} resource by id`,
      operationId: `patch${resource}`,
      requestBody: {
        required: true,
        content: {
          "application/json-patch+json": {
            schema: {
              type: "array",
              items: { type: "object", additionalProperties: true },
              description: "JSON Patch operations (RFC 6902)",
            },
          },
        },
      },
      responses: {
        "200": { description: `${resource} patched`, content: body() },
        ...errorResponses(),
      },
    };
  }
  if (want("delete")) {
    instanceItem.delete = {
      tags: [resource],
      summary: `Delete a ${resource} resource by id`,
      operationId: `delete${resource}`,
      responses: { "204": { description: `${resource} deleted` }, ...errorResponses() },
    };
  }
  if (Object.keys(instanceItem).length > 0) {
    paths[`/${resource}/{id}`] = { parameters: [idParam()], ...instanceItem };
  }

  if (want("history-instance")) {
    paths[`/${resource}/{id}/_history`] = {
      parameters: [idParam()],
      get: {
        tags: [resource],
        summary: `History of a ${resource} instance`,
        operationId: `history${resource}Instance`,
        parameters: historyParameters(),
        responses: {
          "200": { description: "History bundle", content: fhirContent("Bundle") },
          ...errorResponses(),
        },
      },
    };
  }
  if (want("vread")) {
    paths[`/${resource}/{id}/_history/{vid}`] = {
      parameters: [idParam(), idParameter("vid", "Version id of the resource")],
      get: {
        tags: [resource],
        summary: `Read a specific version of a ${resource} resource`,
        operationId: `vread${resource}`,
        responses: {
          "200": { description: `The ${resource} resource version`, content: body() },
          ...errorResponses(),
        },
      },
    };
  }
  if (want("history-type")) {
    paths[`/${resource}/_history`] = {
      get: {
        tags: [resource],
        summary: `History across all ${resource} resources`,
        operationId: `history${resource}Type`,
        parameters: historyParameters(),
        responses: {
          "200": { description: "History bundle", content: fhirContent("Bundle") },
          ...errorResponses(),
        },
      },
    };
  }

  return paths;
}
