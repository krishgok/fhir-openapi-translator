export { generateOpenApi, listResources } from "./generate.js";
export { loadIg, loadIgSync, type IgContext, type IgProfile } from "./ig/package.js";
export {
  diffAgainstYaml,
  mergeIntoYaml,
  stringifyDocument,
  MergeConflictError,
  type MergeConflict,
  type MergeOptions,
  type SpecDiff,
} from "./merge.js";
export type {
  FhirVersion,
  GenerateOptions,
  IgContextLike,
  OpenApiDocument,
  OpenApiVersion,
  SourceBackend,
  TrimOptions,
} from "./types.js";
export { FHIR_VERSIONS, FHIR_VERSION_NUMBERS } from "./types.js";
