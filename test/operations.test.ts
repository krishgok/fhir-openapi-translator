import { describe, expect, it } from "vitest";
import { generateOpenApi } from "../src/index.js";

const withOps = (resources: string[], fhirVersion: "r4" | "r4b" | "r5" = "r4") =>
  generateOpenApi({ resources, fhirVersion, operations: true }) as any;

describe("FHIR operations (--operations)", () => {
  it("is off by default: no $ paths", () => {
    const doc = generateOpenApi({ resources: ["Patient"], fhirVersion: "r4" }) as any;
    expect(Object.keys(doc.paths).some((p) => p.includes("$"))).toBe(false);
  });

  it("$everything becomes GET on instance and type level with primitive query params", () => {
    const doc = withOps(["Patient"]);
    const instance = doc.paths["/Patient/{id}/$everything"];
    expect(instance).toBeDefined();
    expect(instance.get).toBeDefined();
    expect(instance.post).toBeUndefined();
    expect(instance.get.operationId).toBe("everythingPatientInstance");
    const paramNames = instance.get.parameters.map((p: any) => p.name);
    expect(paramNames).toEqual(expect.arrayContaining(["start", "end", "_since", "_count"]));
    // Repeating primitive (_type, max *) is an exploded array parameter.
    const typeParam = instance.get.parameters.find((p: any) => p.name === "_type");
    expect(typeParam.schema.type).toBe("array");
    expect(typeParam.explode).toBe(true);
    // $everything returns a Bundle.
    expect(instance.get.responses["200"].content["application/fhir+json"].schema.$ref).toBe(
      "#/components/schemas/Bundle",
    );
    expect(doc.paths["/Patient/$everything"].get.operationId).toBe("everythingPatientType");
  });

  it("operations with complex inputs become POST with a Parameters body", () => {
    const doc = withOps(["Patient"]);
    // Resource-validate has a `resource` (Resource-typed) in parameter and
    // applies to every resource type.
    const validate = doc.paths["/Patient/$validate"];
    expect(validate.post).toBeDefined();
    expect(validate.get).toBeUndefined();
    expect(validate.post.requestBody.content["application/fhir+json"].schema.$ref).toBe(
      "#/components/schemas/Parameters",
    );
    // Parameters entered the schema closure.
    expect(doc.components.schemas.Parameters).toBeDefined();
  });

  it("errors use the shared OperationOutcome default response", () => {
    const doc = withOps(["Patient"]);
    const everything = doc.paths["/Patient/{id}/$everything"].get;
    expect(everything.responses.default.content["application/fhir+json"].schema.$ref).toBe(
      "#/components/schemas/OperationOutcome",
    );
  });

  it("is deterministic across runs", () => {
    expect(withOps(["Patient", "Observation"])).toEqual(withOps(["Patient", "Observation"]));
  });

  it("works across FHIR versions", () => {
    for (const fhirVersion of ["r4", "r4b", "r5"] as const) {
      const doc = withOps(["Patient"], fhirVersion);
      expect(doc.paths["/Patient/{id}/$everything"], fhirVersion).toBeDefined();
    }
  });
});
