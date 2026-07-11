import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";
import { generateOpenApi, FHIR_VERSIONS } from "../src/index.js";
import type { SourceBackend } from "../src/types.js";

// Recursive and structurally awkward resources on purpose: Bundle (nests
// resources), Questionnaire (contentReference recursion), StructureDefinition
// (metadata about itself).
const RESOURCES = ["Patient", "Observation", "Questionnaire", "StructureDefinition"];
const BACKENDS: SourceBackend[] = ["schema-json", "structure-def"];

describe("generated specs validate as OpenAPI 3.0.3", () => {
  for (const fhirVersion of FHIR_VERSIONS) {
    for (const source of BACKENDS) {
      it(`${fhirVersion} / ${source}`, async () => {
        const doc = generateOpenApi({
          resources: RESOURCES,
          fhirVersion,
          openApiVersion: "3.0.3",
          source,
        });
        // swagger-parser mutates its input while dereferencing.
        await expect(
          SwaggerParser.validate(structuredClone(doc) as never),
        ).resolves.toBeDefined();
      }, 120_000);
    }
  }
});

describe("generated 3.1 specs are structurally sound", () => {
  // swagger-parser has no OpenAPI 3.1 support; assert the invariants directly.
  for (const fhirVersion of FHIR_VERSIONS) {
    it(`${fhirVersion} / schema-json`, () => {
      const doc = generateOpenApi({
        resources: RESOURCES,
        fhirVersion,
        openApiVersion: "3.1.0",
      }) as any;
      expect(doc.openapi).toBe("3.1.0");
      // Every $ref must resolve inside the document.
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
    });
  }
});
