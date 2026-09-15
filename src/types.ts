export type FhirVersion = "r4" | "r4b" | "r5";

export const FHIR_VERSIONS: readonly FhirVersion[] = ["r4", "r4b", "r5"];

export const FHIR_VERSION_NUMBERS: Record<FhirVersion, string> = {
  r4: "4.0.1",
  r4b: "4.3.0",
  r5: "5.0.0",
};

export type OpenApiVersion = "3.0.3" | "3.1.0";

export type SourceBackend = "schema-json" | "structure-def";

export interface TrimOptions {
  /**
   * Replace the Narrative type (human-readable HTML in `Resource.text`) with a
   * generic object. Shrinks generated models that never render narratives.
   */
  excludeNarrative?: boolean;
  /**
   * Stub out schema definitions first reached deeper than this many hops from
   * a requested resource with a generic object. Bounds the size of the
   * dependency closure for codegen targets that struggle with large graphs.
   */
  maxDepth?: number;
  /**
   * Replace required-binding enums on code fields with plain strings (the
   * allowed codes are appended to the description). Codegen'd models then
   * tolerate servers that return codes outside the strict ValueSet — a common
   * reality with legacy data. `resourceType` discriminators keep their enum.
   */
  noEnums?: boolean;
}

/** An IG package resolved to profiles + terminology (see ig/package.ts). */
export interface IgContextLike {
  name: string;
  version: string;
  fhirVersion: FhirVersion;
  profiles: unknown[];
  profilesMissingSnapshot: string[];
  resolveValueSet: (valueSetUrl: string) => string[] | undefined;
}

/** Preset selections accepted by `--search-params`. */
export type SearchParamPreset = "all" | "minimal" | "none";

/**
 * Which resource-specific search parameters to emit. A `default` applies to
 * every resource; `byResource` overrides it per resource. The common result
 * parameters (`_id`, `_count`, ...) are always emitted regardless.
 */
export interface SearchParamSelection {
  default?: SearchParamPreset | ReadonlySet<string>;
  byResource?: ReadonlyMap<string, SearchParamPreset | ReadonlySet<string>>;
}

/** A parsed CapabilityStatement (see capability.ts). */
export interface CapabilityLike {
  fhirVersion?: string;
  resources: {
    type: string;
    interactions: Set<string>;
    searchParamCodes: Set<string>;
    operations: Set<string>;
  }[];
}

export interface GenerateOptions {
  /**
   * FHIR resource names, e.g. ["Patient", "Observation"]. Optional when a
   * `capability` statement is given (its declared resources are used); when
   * both are set, generation is narrowed to the requested resources.
   */
  resources?: string[];
  fhirVersion: FhirVersion;
  /**
   * A parsed CapabilityStatement restricting generation to one server's
   * declared support (resources, interactions, search params, operations).
   * Use `loadCapabilityStatement` / `parseCapabilityStatement` to build it.
   */
  capability?: CapabilityLike;
  /**
   * IG package to apply profiles from: a local path (`.tgz` or unpacked
   * directory) loaded synchronously, or a pre-resolved IgContext (use the
   * async `loadIg` for registry coordinates). Required when `profiles` is set.
   */
  ig?: string | IgContextLike;
  /**
   * Profile ids, names, or canonical URLs to apply to their base resources.
   * Each profiled resource's schemas/paths reference the named profile schema.
   */
  profiles?: string[];
  /** Target OpenAPI version. Default: "3.0.3" (widest codegen support). */
  openApiVersion?: OpenApiVersion;
  /** Definition source backend. Default: "schema-json". */
  source?: SourceBackend;
  /**
   * Also emit the standard FHIR operations applicable to the requested
   * resources ($everything, $validate, ...) from the official
   * OperationDefinitions. Default: false.
   */
  operations?: boolean;
  /** Server base URL for the `servers` entry. Omitted when not given. */
  baseUrl?: string;
  /** Override the generated `info.title`. */
  title?: string;
  trim?: TrimOptions;
  /**
   * Restrict which resource-specific search parameters are emitted. Servers
   * commonly index only a subset, and every indexed parameter costs storage
   * and write throughput; this keeps the published contract matched to what a
   * deployment actually supports. Combined with `capability`, the two narrow
   * each other (the intersection is emitted).
   */
  searchParams?: SearchParamSelection;
}

/** A JSON-Schema-like node. Kept loose: definitions come from vendored files. */
export type JsonSchemaNode = { [key: string]: unknown };

/** A generated OpenAPI document (3.0.3 or 3.1.0) as a plain object. */
export type OpenApiDocument = { [key: string]: unknown };
