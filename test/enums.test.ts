import { describe, expect, it } from "vitest";
import { generateOpenApi } from "../src/index.js";

const GENDER_CODES = ["male", "female", "other", "unknown"];

describe("required-binding enums", () => {
  it("schema-json backend carries the official inline enums", () => {
    const doc = generateOpenApi({ resources: ["Patient"], fhirVersion: "r4" }) as any;
    const gender = doc.components.schemas.Patient.properties.gender;
    expect([...gender.enum].sort()).toEqual([...GENDER_CODES].sort());
  });

  // Regression: HL7 stopped inlining enums in fhir.schema.json after R4, so the
  // default backend silently emitted plain code refs for R4B/R5 while only R4
  // was ever asserted here. Both backends must agree, on every version.
  it("both backends resolve the same enums on every FHIR version", () => {
    for (const fhirVersion of ["r4", "r4b", "r5"] as const) {
      for (const source of ["schema-json", "structure-def"] as const) {
        const label = `${fhirVersion}/${source}`;

        const patient = generateOpenApi({
          resources: ["Patient"],
          fhirVersion,
          source,
        }) as any;
        expect([...patient.components.schemas.Patient.properties.gender.enum].sort(), label).toEqual(
          [...GENDER_CODES].sort(),
        );

        const observation = generateOpenApi({
          resources: ["Observation"],
          fhirVersion,
          source,
        }) as any;
        const status = observation.components.schemas.Observation.properties.status;
        expect(status.enum, label).toBeDefined();
        expect(status.enum, label).toContain("final");
        expect(status.$ref, label).toBeUndefined();
      }
    }
  });

  it("structure-def backend resolves the same enums from ValueSets", () => {
    for (const fhirVersion of ["r4", "r4b", "r5"] as const) {
      const doc = generateOpenApi({
        resources: ["Patient"],
        fhirVersion,
        source: "structure-def",
      }) as any;
      const gender = doc.components.schemas.Patient.properties.gender;
      expect([...gender.enum].sort(), fhirVersion).toEqual([...GENDER_CODES].sort());
      // Observation.status: required binding with a code list.
      const obs = generateOpenApi({
        resources: ["Observation"],
        fhirVersion,
        source: "structure-def",
      }) as any;
      expect(obs.components.schemas.Observation.properties.status.enum, fhirVersion).toContain(
        "final",
      );
    }
  });

  it("--no-enums strips binding enums but keeps codes in the description", () => {
    const doc = generateOpenApi({
      resources: ["Patient"],
      fhirVersion: "r4",
      trim: { noEnums: true },
    }) as any;
    const gender = doc.components.schemas.Patient.properties.gender;
    expect(gender.enum).toBeUndefined();
    expect(gender.type).toBe("string");
    expect(gender.description).toContain("male | female | other | unknown");
  });

  it("--no-enums keeps the resourceType discriminator in both OpenAPI versions", () => {
    // resourceType comes from a JSON Schema `const`, not a binding enum, so
    // --no-enums must not touch it. Its representation differs by target:
    // OpenAPI 3.0.3 downconverts const to a single-value enum, 3.1.0 keeps const.
    const doc303 = generateOpenApi({
      resources: ["Patient"],
      fhirVersion: "r4",
      trim: { noEnums: true },
    }) as any;
    expect(doc303.components.schemas.Patient.properties.resourceType.enum).toEqual(["Patient"]);

    const doc310 = generateOpenApi({
      resources: ["Patient"],
      fhirVersion: "r4",
      openApiVersion: "3.1.0",
      trim: { noEnums: true },
    }) as any;
    expect(doc310.components.schemas.Patient.properties.resourceType.const).toBe("Patient");
  });

  it("unresolvable bindings stay plain code refs (no invented enums)", () => {
    // Patient.communication.language binds to all of BCP-47; not enumerable.
    const doc = generateOpenApi({
      resources: ["Patient"],
      fhirVersion: "r4",
      source: "structure-def",
    }) as any;
    const language = doc.components.schemas.Patient_Communication.properties.language;
    expect(JSON.stringify(language)).not.toContain("enum");
  });
});
