import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FhirVersion, JsonSchemaNode } from "./types.js";

/**
 * The vendored `definitions/` directory sits at the package root, next to
 * `src/` (dev) or `dist/` (published build), so walking up from this module
 * finds it in both layouts.
 */
function definitionsRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "definitions");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("Could not locate the vendored FHIR definitions directory");
}

const cache = new Map<string, unknown>();

function loadGzJson(fhirVersion: FhirVersion, file: string): unknown {
  const key = `${fhirVersion}/${file}`;
  let value = cache.get(key);
  if (value === undefined) {
    const fullPath = path.join(definitionsRoot(), fhirVersion, `${file}.gz`);
    value = JSON.parse(gunzipSync(fs.readFileSync(fullPath)).toString("utf8"));
    cache.set(key, value);
  }
  return value;
}

export interface FhirJsonSchema {
  discriminator?: { propertyName: string; mapping: Record<string, string> };
  definitions: Record<string, JsonSchemaNode>;
}

export function loadFhirSchema(fhirVersion: FhirVersion): FhirJsonSchema {
  return loadGzJson(fhirVersion, "fhir.schema.json") as FhirJsonSchema;
}

export interface SearchParameter {
  name: string;
  code: string;
  base: string[];
  type: string;
  description?: string;
}

export function loadSearchParameters(fhirVersion: FhirVersion): SearchParameter[] {
  const bundle = loadGzJson(fhirVersion, "search-parameters.json") as {
    entry?: { resource?: SearchParameter & { resourceType: string } }[];
  };
  return (bundle.entry ?? [])
    .map((e) => e.resource)
    .filter(
      // R4B ships a few draft codesystem-extensions-* SearchParameters with no
      // `base`; they can't be attached to any resource, so drop them here.
      (r): r is SearchParameter & { resourceType: string } =>
        r?.resourceType === "SearchParameter" && Array.isArray(r.base),
    );
}

export interface MinOperationParameter {
  name: string;
  use: "in" | "out";
  min: number;
  max: string;
  /** Absent for multi-part parameters (they force POST + Parameters). */
  type?: string;
  documentation?: string;
}

export interface MinOperationDefinition {
  name: string;
  code: string;
  url: string;
  description?: string;
  /** Applicable resource types; ["Resource"] means every resource. */
  resource: string[];
  system: boolean;
  type: boolean;
  instance: boolean;
  parameters: MinOperationParameter[];
}

export function loadOperationDefinitions(fhirVersion: FhirVersion): MinOperationDefinition[] {
  return loadGzJson(fhirVersion, "operation-definitions.json") as MinOperationDefinition[];
}

export interface MinElementType {
  code: string;
  targetProfile?: string[];
  fhirType?: string;
}

export interface MinElement {
  path: string;
  min: number;
  max: string;
  short?: string;
  definition?: string;
  contentReference?: string;
  types?: MinElementType[];
  binding?: { strength: string; valueSet: string; codes?: string[] };
  /**
   * Value the element is fixed to by a profile (`fixed[x]`), normalized to a
   * JSON value. Only populated for profiles loaded from an IG package; the
   * vendored base definitions do not carry it.
   */
  fixed?: unknown;
  /** Profile `mustSupport` flag (surfaced in descriptions, not enforced). */
  mustSupport?: boolean;
  /**
   * Human labels for profile constraints this tool does not enforce in
   * OpenAPI (e.g. "pattern", "slicing"), surfaced in the property description
   * and `x-fhir-constraints-omitted`. IG profiles only.
   */
  omittedConstraints?: string[];
}

export interface MinStructureDefinition {
  name: string;
  url: string;
  kind: "resource" | "complex-type" | "primitive-type";
  type: string;
  abstract: boolean;
  baseDefinition?: string;
  elements: MinElement[];
}

export function loadStructureDefinitions(fhirVersion: FhirVersion): MinStructureDefinition[] {
  return loadGzJson(fhirVersion, "structure-definitions.json") as MinStructureDefinition[];
}
