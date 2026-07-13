import { describe, expect, it } from "vitest";
import { generateOpenApi, listResources, FHIR_VERSIONS } from "../src/index.js";
import type { FhirVersion, JsonSchemaNode } from "../src/types.js";

function schemas(doc: Record<string, any>): Record<string, JsonSchemaNode> {
  return (doc.components as any).schemas;
}

describe("listResources", () => {
  it("lists concrete resource types for every FHIR version", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      const names = listResources(fhirVersion);
      expect(names).toContain("Patient");
      expect(names).toContain("Observation");
      expect(names).toContain("Bundle");
      expect(names.length).toBeGreaterThan(100);
      // Abstract types and non-official extensions must not appear.
      expect(names).not.toContain("Resource");
      expect(names).not.toContain("DomainResource");
      expect(names).not.toContain("AccessPolicy");
    }
  });

  it("rejects unknown FHIR versions", () => {
    expect(() => listResources("r3" as FhirVersion)).toThrow(/Unsupported FHIR version/);
  });
});

describe("generateOpenApi", () => {
  it("produces a spec with the resource, its closure, Bundle and OperationOutcome", () => {
    const doc = generateOpenApi({ resources: ["Patient"], fhirVersion: "r4" });
    const s = schemas(doc);
    expect(s.Patient).toBeDefined();
    expect(s.HumanName).toBeDefined(); // direct dependency
    expect(s.Patient_Contact).toBeDefined(); // backbone element
    expect(s.Bundle).toBeDefined();
    expect(s.OperationOutcome).toBeDefined();
    expect(s.Extension).toBeDefined(); // recursive type survives
  });

  it("resolves resource names case-insensitively and rejects unknown ones", () => {
    const doc = generateOpenApi({ resources: ["patient"], fhirVersion: "r4" });
    expect(schemas(doc).Patient).toBeDefined();
    expect(() => generateOpenApi({ resources: ["NotAResource"], fhirVersion: "r4" })).toThrow(
      /Unknown FHIR R4 resource/,
    );
  });

  it("narrows ResourceList instead of dragging in every resource type", () => {
    const doc = generateOpenApi({ resources: ["Bundle"], fhirVersion: "r4" });
    const s = schemas(doc);
    const resourceList = s.ResourceList as { oneOf: { $ref: string }[] };
    expect(resourceList.oneOf.length).toBeLessThan(5);
    expect(s.Account).toBeUndefined();
    // A Bundle-only spec must stay far smaller than the full 600+ definition graph.
    expect(Object.keys(s).length).toBeLessThan(200);
  });

  it("emits const for 3.1 and single-value enum for 3.0.3", () => {
    const doc30 = generateOpenApi({ resources: ["Patient"], fhirVersion: "r4" });
    const doc31 = generateOpenApi({
      resources: ["Patient"],
      fhirVersion: "r4",
      openApiVersion: "3.1.0",
    });
    const rt30 = (schemas(doc30).Patient as any).properties.resourceType;
    const rt31 = (schemas(doc31).Patient as any).properties.resourceType;
    expect(rt30.enum).toEqual(["Patient"]);
    expect(rt30.const).toBeUndefined();
    expect(rt31.const).toBe("Patient");
  });

  it("strips patterns from non-string primitives", () => {
    const doc = generateOpenApi({ resources: ["Patient"], fhirVersion: "r4" });
    const s = schemas(doc) as any;
    expect(s.boolean.pattern).toBeUndefined();
    expect(s.decimal.pattern).toBeUndefined();
    expect(s.id.pattern).toBeDefined(); // string primitives keep theirs
  });

  it("rewrites refs to #/components/schemas", () => {
    const doc = generateOpenApi({ resources: ["Patient"], fhirVersion: "r4" });
    const text = JSON.stringify(doc);
    expect(text).not.toContain("#/definitions/");
  });

  it("generates the standard REST interactions", () => {
    const doc = generateOpenApi({ resources: ["Patient"], fhirVersion: "r4" }) as any;
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/Patient",
      "/Patient/_history",
      "/Patient/{id}",
      "/Patient/{id}/_history",
      "/Patient/{id}/_history/{vid}",
    ]);
    expect(doc.paths["/Patient"].get.operationId).toBe("searchPatient");
    expect(doc.paths["/Patient"].post.operationId).toBe("createPatient");
    expect(doc.paths["/Patient/{id}"].delete.responses["204"]).toBeDefined();
    // Resource-specific search parameters come from the vendored SearchParameters.
    const paramNames = doc.paths["/Patient"].get.parameters
      .filter((p: any) => p.name)
      .map((p: any) => p.name);
    expect(paramNames).toContain("birthdate");
  });

  it("supports trim options", () => {
    const doc = generateOpenApi({
      resources: ["Patient"],
      fhirVersion: "r4",
      trim: { excludeNarrative: true },
    }) as any;
    expect(doc.components.schemas.Narrative.type).toBe("object");
    expect(doc.components.schemas.Narrative.properties).toBeUndefined();
    expect(doc.components.schemas.xhtml).toBeUndefined();

    const bounded = generateOpenApi({
      resources: ["Patient"],
      fhirVersion: "r4",
      trim: { maxDepth: 1 },
    }) as any;
    const full = generateOpenApi({ resources: ["Patient"], fhirVersion: "r4" }) as any;
    expect(JSON.stringify(bounded).length).toBeLessThan(JSON.stringify(full).length);
  });

  it("only includes servers when a baseUrl is given", () => {
    const bare = generateOpenApi({ resources: ["Patient"], fhirVersion: "r4" });
    expect(bare.servers).toBeUndefined();
    const withServer = generateOpenApi({
      resources: ["Patient"],
      fhirVersion: "r4",
      baseUrl: "https://fhir.example.org/r4",
    }) as any;
    expect(withServer.servers[0].url).toBe("https://fhir.example.org/r4");
  });
});
