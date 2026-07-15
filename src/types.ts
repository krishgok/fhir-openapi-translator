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

export interface GenerateOptions {
  /** FHIR resource names, e.g. ["Patient", "Observation"]. */
  resources: string[];
  fhirVersion: FhirVersion;
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
}

/** A JSON-Schema-like node. Kept loose: definitions come from vendored files. */
export type JsonSchemaNode = { [key: string]: unknown };

/** A generated OpenAPI document (3.0.3 or 3.1.0) as a plain object. */
export type OpenApiDocument = { [key: string]: unknown };
