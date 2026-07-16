import { loadStructureDefinitions } from "../definitions.js";
import type { DefinitionRegistry } from "../ir/registry.js";
import { emitStructureDefinitionSchemas } from "../ir/structureWalker.js";
import type { FhirVersion, JsonSchemaNode } from "../types.js";
import type { IgContext, IgProfile } from "./package.js";
import type { ValueSetResolver } from "./minimize.js";

export interface AppliedProfile {
  /** Component schema name emitted for the profile (e.g. "USCorePatient"). */
  schemaName: string;
  /** Base resource type the profile constrains (e.g. "Patient"). */
  resourceType: string;
  /** Versionless canonical URL of the profile. */
  url: string;
}

/**
 * A ValueSet resolver backed by the vendored core definitions: base elements
 * already carry the resolved code list for their required binding, so core
 * ValueSets (e.g. administrative-gender) referenced by profile elements can be
 * resolved without shipping the core ValueSets themselves.
 */
export function buildCoreValueSetFallback(fhirVersion: FhirVersion): ValueSetResolver {
  const map = new Map<string, string[]>();
  for (const sd of loadStructureDefinitions(fhirVersion)) {
    for (const el of sd.elements) {
      if (el.binding?.codes?.length && el.binding.valueSet) {
        const key = el.binding.valueSet.split("|")[0]!;
        if (!map.has(key)) map.set(key, el.binding.codes);
      }
    }
  }
  return (valueSetUrl) => map.get(valueSetUrl.split("|")[0]!);
}

function sanitizeSchemaName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "");
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `Profile${cleaned}`;
}

/** Finds a profile in the IG by canonical URL, id, or name (case-insensitive). */
function findProfile(context: IgContext, requested: string): IgProfile {
  const needle = requested.toLowerCase();
  const matches = context.profiles.filter(
    (p) =>
      p.url.toLowerCase() === needle ||
      p.id?.toLowerCase() === needle ||
      p.name.toLowerCase() === needle,
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `Profile "${requested}" is ambiguous in ${context.name}; match by canonical URL. ` +
        `Candidates: ${matches.map((p) => p.url).join(", ")}`,
    );
  }
  if (context.profilesMissingSnapshot.some((p) => p.toLowerCase() === needle)) {
    throw new Error(
      `Profile "${requested}" in ${context.name} has no snapshot. Snapshot generation is ` +
        `out of scope; use a snapshot-bearing release of the IG.`,
    );
  }
  const available = context.profiles.map((p) => p.id ?? p.name).sort();
  throw new Error(
    `Profile "${requested}" not found in ${context.name}@${context.version}. ` +
      `Available profiles: ${available.join(", ") || "none"}`,
  );
}

/**
 * Emits the profiled schema (and its backbones) into the registry, applying
 * the profile's constraints, and returns how it maps onto the base resource.
 * Unconstrained elements resolve to base type refs, so the dependency closure
 * still draws from the vendored core registry.
 */
export function applyProfile(
  context: IgContext,
  requested: string,
  registry: DefinitionRegistry,
): AppliedProfile {
  const profile = findProfile(context, requested);
  let schemaName = sanitizeSchemaName(profile.name);
  // Guard against collision with a base definition of a different shape.
  if (registry.definitions.has(schemaName) && schemaName !== profile.type) {
    schemaName = `${schemaName}Profile`;
  }

  emitStructureDefinitionSchemas(profile.definition, registry.definitions, {
    rootName: schemaName,
    isResourceRoot: true,
    resourceDisplayName: profile.type,
    profile: true,
  });

  const schema = registry.definitions.get(schemaName) as JsonSchemaNode | undefined;
  if (schema) schema["x-fhir-profile"] = profile.url;

  return { schemaName, resourceType: profile.type, url: profile.url };
}
