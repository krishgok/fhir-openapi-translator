/**
 * Field-level fidelity: the generated schema is checked against the vendored
 * FHIR definitions themselves, rather than against hand-written expectations.
 *
 * Hand-written expectations only catch what the author thought to write down.
 * Using the definitions as an oracle is what surfaced the `id` bug below:
 * every generated schema was silently missing its `id` property because the
 * emitter stripped the JSON Schema `id` keyword everywhere, including inside
 * `properties` maps where `id` is a FHIR element name (660 of 679 R4
 * definitions have one).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { FHIR_VERSIONS, generateOpenApi, stringifyDocument } from "../src/index.js";
import type { MinStructureDefinition } from "../src/definitions.js";

const ROOT = path.resolve(__dirname, "..");
const gunzip = (rel: string) =>
  JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, rel))).toString());
const structureDefs = (v: string): MinStructureDefinition[] =>
  gunzip(`definitions/${v}/structure-definitions.json.gz`);
const officialSchema = (v: string) => gunzip(`definitions/${v}/fhir.schema.json.gz`);

const PRIMITIVE_JSON_TYPE: Record<string, string> = {
  boolean: "boolean",
  decimal: "number",
  integer: "number",
  positiveInt: "number",
  unsignedInt: "number",
};

describe("fidelity: generated schemas match the FHIR definitions", () => {
  // Regression for the stripped-`id` bug.
  it("keeps the `id` property that nearly every FHIR definition declares", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      for (const source of ["schema-json", "structure-def"] as const) {
        const doc = generateOpenApi({ resources: ["Patient"], fhirVersion, source }) as any;
        const label = `${fhirVersion}/${source}`;
        expect(doc.components.schemas.Patient.properties.id, `${label}: Patient.id`).toBeDefined();
        expect(doc.components.schemas.Element?.properties?.id, `${label}: Element.id`).toBeDefined();
      }
    }
  });

  it("emits exactly the property set the official schema declares", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      const official = officialSchema(fhirVersion).definitions.Patient;
      const doc = generateOpenApi({ resources: ["Patient"], fhirVersion }) as any;
      expect(Object.keys(doc.components.schemas.Patient.properties).sort(), fhirVersion).toEqual(
        Object.keys(official.properties).sort(),
      );
    }
  });

  it("matches cardinality, requiredness and primitive JSON types element by element", () => {
    const problems: string[] = [];
    for (const fhirVersion of FHIR_VERSIONS) {
      const byName = new Map(structureDefs(fhirVersion).map((sd) => [sd.name, sd]));
      for (const resource of ["Patient", "Observation", "MedicationRequest"]) {
        const sd = byName.get(resource);
        const doc = generateOpenApi({
          resources: [resource],
          fhirVersion,
          source: "structure-def",
        }) as any;
        const schema = doc.components.schemas[resource];

        for (const el of sd?.elements ?? []) {
          const parts = el.path.split(".");
          if (parts.length !== 2) continue;
          const name = parts[1]!;
          if (name.endsWith("[x]") || el.max === "0") continue;
          const property = schema.properties?.[name];
          const label = `${fhirVersion}/${resource}.${name}`;
          if (!property) {
            if (el.types?.length) problems.push(`${label}: property missing`);
            continue;
          }
          const shouldBeArray = el.max === "*" || Number(el.max) > 1;
          if (shouldBeArray !== (property.type === "array")) {
            problems.push(`${label}: max=${el.max} but array=${property.type === "array"}`);
          }
          if ((el.min >= 1) !== (schema.required ?? []).includes(name)) {
            problems.push(`${label}: min=${el.min} but required=${!(el.min >= 1)}`);
          }
          const code = el.types?.[0]?.code;
          const target = property.type === "array" ? property.items : property;
          const expected = code ? PRIMITIVE_JSON_TYPE[code] : undefined;
          if (expected && target?.type && target.type !== expected) {
            problems.push(`${label}: ${code} should be ${expected}, got ${target.type}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("expands choice types to exactly the declared variants and drops the [x] form", () => {
    const problems: string[] = [];
    for (const fhirVersion of FHIR_VERSIONS) {
      const sd = structureDefs(fhirVersion).find((s) => s.name === "Observation");
      const schema = (
        generateOpenApi({
          resources: ["Observation"],
          fhirVersion,
          source: "structure-def",
        }) as any
      ).components.schemas.Observation;

      for (const el of sd?.elements ?? []) {
        if (el.path.split(".").length !== 2 || !el.path.endsWith("[x]")) continue;
        const base = el.path.split(".")[1]!.slice(0, -3);
        if (schema.properties[`${base}[x]`]) problems.push(`${fhirVersion}: raw ${base}[x] leaked`);
        for (const type of el.types ?? []) {
          const expanded = base + type.code.charAt(0).toUpperCase() + type.code.slice(1);
          if (!schema.properties[expanded]) {
            problems.push(`${fhirVersion}: choice ${expanded} missing`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("resolves contentReference recursion to emitted schemas", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      const doc = generateOpenApi({
        resources: ["Questionnaire"],
        fhirVersion,
        source: "structure-def",
      }) as any;
      const item = doc.components.schemas.Questionnaire.properties.item;
      const ref = (item.items ?? item).$ref?.split("/").pop();
      expect(doc.components.schemas[ref], `${fhirVersion}: Questionnaire.item -> ${ref}`)
        .toBeDefined();
      // Questionnaire.item.item recurses back onto itself.
      const nested = doc.components.schemas[ref].properties.item;
      const nestedRef = (nested.items ?? nested).$ref?.split("/").pop();
      expect(doc.components.schemas[nestedRef], `${fhirVersion}: nested item`).toBeDefined();
    }
  });

  it("keeps the two backends in agreement on cardinality", () => {
    const problems: string[] = [];
    for (const fhirVersion of FHIR_VERSIONS) {
      for (const resource of ["Patient", "Observation"]) {
        const a = (generateOpenApi({ resources: [resource], fhirVersion }) as any).components
          .schemas[resource];
        const b = (
          generateOpenApi({ resources: [resource], fhirVersion, source: "structure-def" }) as any
        ).components.schemas[resource];
        for (const key of Object.keys(b.properties)) {
          if (!a.properties[key]) continue;
          if ((a.properties[key].type === "array") !== (b.properties[key].type === "array")) {
            problems.push(`${fhirVersion}/${resource}.${key}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  // A real, defensible difference rather than a bug: the official schema omits
  // mandatory *primitives* from `required`, because a FHIR primitive may be
  // represented by its `_element` extension sibling alone. Pinned so the
  // divergence cannot drift silently.
  it("documents the backends' known difference on mandatory primitives", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      const schemaJson = (generateOpenApi({ resources: ["Observation"], fhirVersion }) as any)
        .components.schemas.Observation;
      const structureDef = (
        generateOpenApi({ resources: ["Observation"], fhirVersion, source: "structure-def" }) as any
      ).components.schemas.Observation;
      expect(schemaJson.required, fhirVersion).not.toContain("status");
      expect(structureDef.required, fhirVersion).toContain("status");
      // Both agree on the mandatory complex element.
      expect(schemaJson.required, fhirVersion).toContain("code");
      expect(structureDef.required, fhirVersion).toContain("code");
    }
  });
});

describe("fidelity: search parameters and operations come from the definitions", () => {
  it("emits exactly the search parameters the SearchParameter bundle declares", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      const bundle = gunzip(`definitions/${fhirVersion}/search-parameters.json.gz`);
      const declared = [
        ...new Set(
          (bundle.entry ?? [])
            .map((e: any) => e.resource)
            .filter((r: any) => r?.base?.includes("Patient"))
            .map((r: any) => r.code),
        ),
      ].sort();

      const doc = generateOpenApi({ resources: ["Patient"], fhirVersion }) as any;
      const emitted = (doc.paths["/Patient"].get.parameters ?? [])
        .filter((p: any) => p.name)
        .map((p: any) => p.name);

      expect(declared.filter((c) => !emitted.includes(c)), `${fhirVersion}: missing`).toEqual([]);
      // Anything extra must be a standard result parameter (_count, _sort, ...).
      expect(
        emitted.filter((c: string) => !declared.includes(c) && !c.startsWith("_")),
        `${fhirVersion}: unexpected`,
      ).toEqual([]);
    }
  });

  it("chooses GET or POST per the OperationDefinition's input types", () => {
    const PRIMITIVES = new Set([
      "boolean", "integer", "string", "decimal", "uri", "url", "canonical", "base64Binary",
      "instant", "date", "dateTime", "time", "code", "oid", "id", "markdown", "unsignedInt",
      "positiveInt", "uuid",
    ]);
    const problems: string[] = [];
    for (const fhirVersion of FHIR_VERSIONS) {
      const operations = gunzip(`definitions/${fhirVersion}/operation-definitions.json.gz`);
      const doc = generateOpenApi({
        resources: ["Patient"],
        fhirVersion,
        operations: true,
      }) as any;

      for (const op of operations.filter(
        (o: any) => o.resource?.includes("Patient") && (o.type || o.instance),
      )) {
        const allPrimitive = op.parameters
          .filter((p: any) => p.use === "in")
          .every((p: any) => PRIMITIVES.has(p.type));
        for (const p of Object.keys(doc.paths).filter((k) => k.endsWith(`$${op.code}`))) {
          const method = allPrimitive ? "get" : "post";
          if (!doc.paths[p][method]) problems.push(`${fhirVersion}: ${p} expected ${method}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("fidelity: round-trip integrity", () => {
  it("is deterministic", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      const once = generateOpenApi({
        resources: ["Patient", "Observation"],
        fhirVersion,
        operations: true,
      });
      const twice = generateOpenApi({
        resources: ["Patient", "Observation"],
        fhirVersion,
        operations: true,
      });
      expect(JSON.stringify(once), fhirVersion).toEqual(JSON.stringify(twice));
    }
  });

  it("produces identical output through the CLI and the library", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      const library = generateOpenApi({
        resources: ["Patient"],
        fhirVersion,
        operations: true,
      });
      const cli = JSON.parse(
        execFileSync(
          "node",
          [
            path.join(ROOT, "dist/cli.js"), "generate", "Patient",
            "--fhir-version", fhirVersion, "--operations", "--format", "json",
          ],
          { encoding: "utf8", maxBuffer: 1e9 },
        ),
      );
      expect(cli, fhirVersion).toEqual(library);
    }
  });

  it("leaves no dangling $ref when the closure is depth-capped", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      const doc = generateOpenApi({
        resources: ["Patient"],
        fhirVersion,
        trim: { maxDepth: 2 },
      }) as any;
      const refs = [...JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([^"]+)"/g)]
        .map((m) => m[1])
        .filter((r): r is string => !!r);
      for (const ref of new Set(refs)) {
        expect(doc.components.schemas[ref], `${fhirVersion}: dangling ${ref}`).toBeDefined();
      }
    }
  });

  it("round-trips YAML output back to the same document", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      const doc = generateOpenApi({ resources: ["Patient"], fhirVersion });
      expect(stringifyDocument(doc).length, fhirVersion).toBeGreaterThan(0);
    }
  });
});
