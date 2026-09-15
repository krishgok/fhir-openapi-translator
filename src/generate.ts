import { buildRegistryFromSchemaJson } from "./backends/schemaJson.js";
import { buildRegistryFromStructureDefinitions } from "./backends/structureDefinition.js";
import type { Capability, ResourceCapability } from "./capability.js";
import { convertSchema } from "./emit/schema.js";
import { loadIgSync, type IgContext } from "./ig/package.js";
import { applyProfile, buildCoreValueSetFallback } from "./ig/profile.js";
import { extractClosure, type DefinitionRegistry } from "./ir/registry.js";
import { buildOperationPaths } from "./operations.js";
import { buildResourcePaths, commonSearchParameterComponents } from "./paths.js";
import { resolveSearchParamCodes } from "./searchParams.js";
import {
  FHIR_VERSION_NUMBERS,
  FHIR_VERSIONS,
  type FhirVersion,
  type GenerateOptions,
  type JsonSchemaNode,
  type OpenApiDocument,
  type SourceBackend,
} from "./types.js";

function buildRegistry(fhirVersion: FhirVersion, source: SourceBackend): DefinitionRegistry {
  return source === "structure-def"
    ? buildRegistryFromStructureDefinitions(fhirVersion)
    : buildRegistryFromSchemaJson(fhirVersion);
}

function resolveResourceName(registry: DefinitionRegistry, requested: string): string {
  const match = registry.resourceNames.find(
    (name) => name.toLowerCase() === requested.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `Unknown FHIR ${registry.fhirVersion.toUpperCase()} resource: "${requested}". ` +
        `Run "fhir-oas list --fhir-version ${registry.fhirVersion}" to see available resources.`,
    );
  }
  return match;
}

/** Lists the resource type names available for a FHIR version. */
export function listResources(
  fhirVersion: FhirVersion,
  source: SourceBackend = "schema-json",
): string[] {
  assertFhirVersion(fhirVersion);
  return [...buildRegistry(fhirVersion, source).resourceNames].sort();
}

function assertFhirVersion(fhirVersion: string): asserts fhirVersion is FhirVersion {
  if (!FHIR_VERSIONS.includes(fhirVersion as FhirVersion)) {
    throw new Error(
      `Unsupported FHIR version "${fhirVersion}". Supported: ${FHIR_VERSIONS.join(", ")}`,
    );
  }
}

/** The FHIR version a CapabilityStatement fhirVersion string belongs to. */
function assertCapabilityFhirVersion(capability: Capability, fhirVersion: FhirVersion): void {
  const declared = capability.fhirVersion;
  if (!declared) return; // statement omitted it; trust the caller's --fhir-version
  const expectedMajor = FHIR_VERSION_NUMBERS[fhirVersion].split(".").slice(0, 2).join(".");
  // R4 (4.0.x) and R4B (4.3.x) share major 4 but differ in minor; compare the
  // major.minor prefix, tolerating the statement carrying only "4.0" etc.
  const declaredPrefix = declared.split(".").slice(0, 2).join(".");
  if (declaredPrefix && expectedMajor && declaredPrefix !== expectedMajor) {
    throw new Error(
      `CapabilityStatement targets FHIR ${declared}, but generation is for ` +
        `${fhirVersion.toUpperCase()} (${FHIR_VERSION_NUMBERS[fhirVersion]}). ` +
        `Set --fhir-version to match the server.`,
    );
  }
}

/** Resolves options.ig to an IgContext: a local path is loaded synchronously. */
function resolveIg(options: GenerateOptions): IgContext {
  const ig = options.ig;
  if (!ig) throw new Error("--profile requires --ig: point at the IG package.");
  if (typeof ig === "string") {
    return loadIgSync(ig, { coreValueSetFallback: buildCoreValueSetFallback(options.fhirVersion) });
  }
  return ig as IgContext;
}

/**
 * Generates an OpenAPI document covering the requested FHIR resources: their
 * full schema dependency closure plus the standard FHIR RESTful interactions.
 */
export function generateOpenApi(options: GenerateOptions): OpenApiDocument {
  assertFhirVersion(options.fhirVersion);
  const openApiVersion = options.openApiVersion ?? "3.0.3";
  if (openApiVersion !== "3.0.3" && openApiVersion !== "3.1.0") {
    throw new Error(`Unsupported OpenAPI version "${openApiVersion}". Supported: 3.0.3, 3.1.0`);
  }

  const registry = buildRegistry(options.fhirVersion, options.source ?? "schema-json");

  // A CapabilityStatement restricts generation to one server's declared
  // surface: which resources, interactions, search params, and operations.
  const capability = options.capability as Capability | undefined;
  const capabilityByResource = new Map<string, ResourceCapability>();
  if (capability) {
    assertCapabilityFhirVersion(capability, options.fhirVersion);
    for (const cap of capability.resources) {
      const match = registry.resourceNames.find(
        (name) => name.toLowerCase() === cap.type.toLowerCase(),
      );
      // Skip resource types the FHIR version doesn't define (custom/unknown).
      if (match) capabilityByResource.set(match, cap);
    }
  }

  const requested = (options.resources ?? []).map((r) => resolveResourceName(registry, r));
  if (requested.length === 0 && capabilityByResource.size === 0) {
    throw new Error(
      capability
        ? "The CapabilityStatement declares no resources this FHIR version supports."
        : "At least one FHIR resource name (or a --capability statement) is required",
    );
  }

  // Apply IG profiles (if any) into the registry, mapping each profiled base
  // resource to its emitted schema name. The base resource is auto-included.
  const schemaByResource = new Map<string, string>();
  // In capability mode, the resource set is the statement's (optionally
  // narrowed to the explicitly requested ones); otherwise it's the requested.
  const resourceSet = new Set<string>(
    capability
      ? requested.length > 0
        ? requested.filter((r) => capabilityByResource.has(r))
        : [...capabilityByResource.keys()]
      : requested,
  );
  if (options.profiles?.length) {
    const ig = resolveIg(options);
    if (ig.fhirVersion !== options.fhirVersion) {
      throw new Error(
        `IG package "${ig.name}" targets FHIR ${ig.fhirVersion.toUpperCase()}, but generation ` +
          `is for ${options.fhirVersion.toUpperCase()}. Use --fhir-version ${ig.fhirVersion}.`,
      );
    }
    for (const profileId of options.profiles) {
      const applied = applyProfile(ig, profileId, registry);
      const base = resolveResourceName(registry, applied.resourceType);
      if (schemaByResource.has(base)) {
        throw new Error(
          `Multiple profiles target ${base}; generate one profiled resource per run.`,
        );
      }
      schemaByResource.set(base, applied.schemaName);
      resourceSet.add(base);
    }
  } else if (options.ig) {
    throw new Error("--ig requires --profile: name the profile(s) to apply.");
  }

  const resources = [...resourceSet];
  const schemaFor = (resource: string) => schemaByResource.get(resource) ?? resource;

  // Operations: in capability mode, emit exactly the operations each resource
  // declares (mapped to known OperationDefinitions); otherwise --operations
  // emits every applicable operation.
  const operationPaths: Record<string, JsonSchemaNode> = {};
  const operationRoots: string[] = [];
  if (capability || options.operations) {
    const knownResources = new Set(registry.resourceNames);
    for (const resource of resources) {
      const cap = capabilityByResource.get(resource);
      if (capability && (!cap || cap.operations.size === 0)) continue;
      const result = buildOperationPaths(options.fhirVersion, resource, knownResources, {
        schemaFor,
        only: cap?.operations,
      });
      Object.assign(operationPaths, result.paths);
      operationRoots.push(...result.extraSchemaRoots);
    }
  }

  // Closure roots use the profiled schema name where a resource is profiled,
  // so the base schema is only emitted if something else references it.
  // Bundle and OperationOutcome are always present: search/history responses
  // are Bundles and every error response is an OperationOutcome.
  const roots = [
    ...new Set([...resources.map(schemaFor), "Bundle", "OperationOutcome", ...operationRoots]),
  ];
  const { schemas } = extractClosure(registry, roots, options.trim ?? {}, roots);

  const componentSchemas: Record<string, JsonSchemaNode> = {};
  const convertOptions = { noEnums: options.trim?.noEnums };
  for (const name of [...schemas.keys()].sort()) {
    componentSchemas[name] = convertSchema(schemas.get(name)!, openApiVersion, convertOptions);
  }

  const paths: Record<string, JsonSchemaNode> = {};
  for (const resource of resources) {
    const cap = capabilityByResource.get(resource);
    // A CapabilityStatement says what the server supports; --search-params
    // narrows further. With both, emit only what satisfies each.
    const selected = resolveSearchParamCodes(options.searchParams, options.fhirVersion, resource);
    const searchParamCodes =
      cap?.searchParamCodes && selected
        ? new Set([...selected].filter((code) => cap.searchParamCodes.has(code)))
        : (selected ?? cap?.searchParamCodes);
    Object.assign(
      paths,
      buildResourcePaths(options.fhirVersion, resource, schemaFor(resource), {
        interactions: cap?.interactions,
        searchParamCodes,
      }),
    );
  }
  Object.assign(paths, operationPaths);

  const fhirNumber = FHIR_VERSION_NUMBERS[options.fhirVersion];
  const document: OpenApiDocument = {
    openapi: openApiVersion,
    info: {
      title:
        options.title ??
        `FHIR ${options.fhirVersion.toUpperCase()} REST API: ${resources.join(", ")}`,
      description:
        `OpenAPI definition of the FHIR ${options.fhirVersion.toUpperCase()} (${fhirNumber}) ` +
        `RESTful interactions and JSON schemas for: ${resources.join(", ")}. ` +
        "Generated by fhir-openapi-translator from the official HL7 FHIR definitions. " +
        "Schema validity does not imply full FHIR conformance: profiles, terminology " +
        "bindings, and FHIRPath invariants are not represented.",
      version: fhirNumber,
    },
    ...(options.baseUrl ? { servers: [{ url: options.baseUrl }] } : {}),
    tags: resources.map((resource) => ({
      name: resource,
      description: `Operations on the ${resource} resource`,
    })),
    paths,
    components: {
      parameters: commonSearchParameterComponents(),
      schemas: componentSchemas,
    },
  };
  return document;
}
