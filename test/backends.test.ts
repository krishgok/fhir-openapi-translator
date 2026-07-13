import { describe, expect, it } from "vitest";
import { buildRegistryFromSchemaJson } from "../src/backends/schemaJson.js";
import { buildRegistryFromStructureDefinitions } from "../src/backends/structureDefinition.js";
import { generateOpenApi } from "../src/index.js";

describe("structure-definition backend cross-check against schema-json", () => {
  it("agrees on the concrete resource type list (r4)", () => {
    const a = new Set(buildRegistryFromSchemaJson("r4").resourceNames);
    const b = new Set(buildRegistryFromStructureDefinitions("r4").resourceNames);
    const onlyA = [...a].filter((n) => !b.has(n));
    const onlyB = [...b].filter((n) => !a.has(n));
    expect(onlyA).toEqual([]);
    expect(onlyB).toEqual([]);
  });

  it("agrees on Patient's properties and required fields (r4)", () => {
    const a = buildRegistryFromSchemaJson("r4").definitions.get("Patient") as any;
    const b = buildRegistryFromStructureDefinitions("r4").definitions.get("Patient") as any;
    const aProps = Object.keys(a.properties).sort();
    const bProps = Object.keys(b.properties).sort();
    expect(bProps).toEqual(aProps);
    expect(b.required ?? []).toEqual(a.required ?? []);
  });

  it("agrees on choice-type expansion for Observation.value[x] (r4)", () => {
    const a = buildRegistryFromSchemaJson("r4").definitions.get("Observation") as any;
    const b = buildRegistryFromStructureDefinitions("r4").definitions.get("Observation") as any;
    const choiceProps = (props: Record<string, unknown>) =>
      Object.keys(props).filter((k) => k.startsWith("value") && !k.startsWith("_"));
    expect(choiceProps(b.properties).sort()).toEqual(choiceProps(a.properties).sort());
  });

  it("handles contentReference recursion (Questionnaire.item.item)", () => {
    const doc = generateOpenApi({
      resources: ["Questionnaire"],
      fhirVersion: "r4",
      source: "structure-def",
    }) as any;
    const item = doc.components.schemas.Questionnaire_Item;
    expect(item).toBeDefined();
    expect(JSON.stringify(item)).toContain("#/components/schemas/Questionnaire_Item");
  });
});
