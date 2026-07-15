import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { generateOpenApi, FHIR_VERSIONS } from "../src/index.js";
import type { OpenApiVersion, SourceBackend } from "../src/types.js";

// Recursive and structurally awkward resources on purpose: Bundle (nests
// resources), Questionnaire (contentReference recursion), StructureDefinition
// (metadata about itself).
const RESOURCES = ["Patient", "Observation", "Questionnaire", "StructureDefinition"];
const BACKENDS: SourceBackend[] = ["schema-json", "structure-def"];
const OPENAPI_VERSIONS: OpenApiVersion[] = ["3.0.3", "3.1.0"];

// Note: @apidevtools/swagger-parser is unusable here — its dereference step
// explodes combinatorially on FHIR's densely shared, circular datatype graph
// (a single-resource spec takes minutes of pegged CPU). This validator checks
// against the official OpenAPI meta-schemas without dereferencing; the $ref
// resolution swagger-parser would have done is asserted directly below.

/** Asserts every internal $ref in the document resolves to a component. */
function expectRefsResolve(doc: any): void {
  const schemas = doc.components.schemas;
  const parameters = doc.components.parameters;
  const check = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(check);
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") {
          const schemaName = value.match(/^#\/components\/schemas\/(.+)$/)?.[1];
          const paramName = value.match(/^#\/components\/parameters\/(.+)$/)?.[1];
          expect(schemaName ?? paramName, `unresolvable ref ${value}`).toBeDefined();
          if (schemaName) expect(schemas[schemaName], value).toBeDefined();
          if (paramName) expect(parameters[paramName], value).toBeDefined();
        } else {
          check(value);
        }
      }
    }
  };
  check(doc);
}

describe("generated specs validate against the OpenAPI meta-schema", () => {
  for (const fhirVersion of FHIR_VERSIONS) {
    for (const source of BACKENDS) {
      for (const openApiVersion of OPENAPI_VERSIONS) {
        it(`${fhirVersion} / ${source} / ${openApiVersion}`, async () => {
          const doc = generateOpenApi({
            resources: RESOURCES,
            fhirVersion,
            openApiVersion,
            source,
          });
          expect((doc as any).openapi).toBe(openApiVersion);
          const result = await new Validator().validate(structuredClone(doc));
          expect(result.errors, JSON.stringify(result.errors ?? null).slice(0, 2000)).toBeUndefined();
          expect(result.valid).toBe(true);
          expectRefsResolve(doc);
        });
      }
    }
  }

  for (const fhirVersion of FHIR_VERSIONS) {
    it(`${fhirVersion} with operations`, async () => {
      const doc = generateOpenApi({
        resources: ["Patient", "Observation"],
        fhirVersion,
        operations: true,
      });
      const result = await new Validator().validate(structuredClone(doc));
      expect(result.errors, JSON.stringify(result.errors ?? null).slice(0, 2000)).toBeUndefined();
      expect(result.valid).toBe(true);
      expectRefsResolve(doc);
    });
  }
});
