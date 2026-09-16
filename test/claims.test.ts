/**
 * One block per README capability claim, exercised across every FHIR version,
 * OpenAPI version and output format the README advertises.
 *
 * These exist because three published claims turned out to be wrong or
 * partly wrong, each time because only one point in the matrix was covered:
 * enums were asserted on R4 only, profiles on us-core-patient only. Anything
 * the README states across a matrix gets asserted across that matrix here.
 */
import { parse } from "yaml";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  FHIR_VERSIONS,
  diffAgainstYaml,
  generateOpenApi,
  mergeIntoYaml,
  parseCapabilityStatement,
  stringifyDocument,
} from "../src/index.js";
import { parseSearchParamSpec } from "../src/searchParams.js";
import fs from "node:fs";

const OPENAPI_VERSIONS = ["3.0.3", "3.1.0"] as const;
const BACKENDS = ["schema-json", "structure-def"] as const;
const FHIR_NUMBERS = { r4: "4.0.1", r4b: "4.3.0", r5: "5.0.0" } as const;
const R5_IG = path.resolve(__dirname, "fixtures/ig-r5-minimal");
const capabilityFixture = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "fixtures/capabilitystatement-minimal.json"),
    "utf8",
  ),
);

const valid = async (doc: unknown) =>
  await new Validator().validate(structuredClone(doc) as never);

describe("claim: R4/R4B/R5 -> OpenAPI 3.0.3 or 3.1.0, YAML or JSON", () => {
  it("emits YAML that round-trips to exactly the JSON document", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      for (const openApiVersion of OPENAPI_VERSIONS) {
        const doc = generateOpenApi({
          resources: ["Patient"],
          fhirVersion,
          openApiVersion,
          operations: true,
        });
        const roundTripped = parse(stringifyDocument(doc));
        expect(roundTripped, `${fhirVersion}/${openApiVersion}`).toEqual(doc);
      }
    }
  });

  it("stamps the declared OpenAPI and FHIR versions", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      for (const openApiVersion of OPENAPI_VERSIONS) {
        const doc = generateOpenApi({
          resources: ["Patient"],
          fhirVersion,
          openApiVersion,
        }) as any;
        expect(doc.openapi, `${fhirVersion}/${openApiVersion}`).toBe(
          openApiVersion,
        );
        expect(doc.info.version, fhirVersion).toBe(FHIR_NUMBERS[fhirVersion]);
      }
    }
  });
});

describe("claim: minimal output - only what you ask for and what it references", () => {
  it("emits no schema unreachable from the requested roots", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      for (const source of BACKENDS) {
        const doc = generateOpenApi({
          resources: ["Patient"],
          fhirVersion,
          source,
        }) as any;
        const schemas: Record<string, unknown> = doc.components.schemas;

        const seen = new Set<string>();
        const stack = ["Patient", "Bundle", "OperationOutcome"];
        while (stack.length) {
          const name = stack.pop();
          if (!name || seen.has(name) || !schemas[name]) continue;
          seen.add(name);
          for (const m of JSON.stringify(schemas[name]).matchAll(
            /"#\/components\/schemas\/([^"]+)"/g,
          )) {
            if (m[1]) stack.push(m[1]);
          }
        }

        const unreachable = Object.keys(schemas).filter((n) => !seen.has(n));
        expect(unreachable, `${fhirVersion}/${source}`).toEqual([]);
      }
    }
  });

  it("does not drag in unrequested resource types", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      const doc = generateOpenApi({
        resources: ["Patient"],
        fhirVersion,
      }) as any;
      // Observation is never reachable from Patient; it must not appear.
      expect(doc.components.schemas.Observation, fhirVersion).toBeUndefined();
      expect(
        Object.keys(doc.paths).every((p) => /^\/(Patient)/.test(p)),
        fhirVersion,
      ).toBe(true);
    }
  });
});

describe("claim: custom operations from the official OperationDefinitions", () => {
  it("emits $everything/$validate/$meta on every version and validates in both OpenAPI versions", async () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      for (const openApiVersion of OPENAPI_VERSIONS) {
        const doc = generateOpenApi({
          resources: ["Patient"],
          fhirVersion,
          openApiVersion,
          operations: true,
        }) as any;
        const label = `${fhirVersion}/${openApiVersion}`;
        const operationPaths = Object.keys(doc.paths).filter((p) =>
          p.includes("$"),
        );
        for (const op of ["everything", "validate", "meta"]) {
          expect(
            operationPaths.some((p) => p.endsWith(`$${op}`)),
            `${label}: missing $${op}`,
          ).toBe(true);
        }
        const result = await valid(doc);
        expect(
          result.errors,
          `${label}: ${JSON.stringify(result.errors ?? null).slice(0, 400)}`,
        ).toBeUndefined();
      }
    }
  });

  it("reflects each version's own OperationDefinitions rather than a fixed list", () => {
    const opsFor = (fhirVersion: (typeof FHIR_VERSIONS)[number]) =>
      Object.keys(
        (
          generateOpenApi({
            resources: ["Patient"],
            fhirVersion,
            operations: true,
          }) as any
        ).paths,
      ).filter((p) => p.includes("$"));
    // R5 adds Patient operations that do not exist in R4 (e.g. $merge).
    expect(opsFor("r5").length).toBeGreaterThan(opsFor("r4").length);
    expect(opsFor("r5").some((p) => p.endsWith("$merge"))).toBe(true);
    expect(opsFor("r4").some((p) => p.endsWith("$merge"))).toBe(false);
  });
});

describe("claim: profiles from any IG package (not just US Core, not just R4)", () => {
  const profiled = (
    openApiVersion: (typeof OPENAPI_VERSIONS)[number] = "3.0.3",
  ) =>
    generateOpenApi({
      resources: ["Patient"],
      fhirVersion: "r5",
      openApiVersion,
      ig: R5_IG,
      profiles: ["minimal-r5-patient"],
    }) as any;

  const schemaOf = (doc: any) =>
    doc.components.schemas[
      Object.keys(doc.components.schemas).find(
        (n) => doc.components.schemas[n]["x-fhir-profile"],
      ) as string
    ];

  it("applies an R5 IG, proving profile support is not R4-specific", () => {
    const schema = schemaOf(profiled());
    expect(schema["x-fhir-profile"]).toBe(
      "http://example.org/fhir/StructureDefinition/minimal-r5-patient",
    );
  });

  it("min>=1 becomes required", () => {
    expect(schemaOf(profiled()).required).toEqual(
      expect.arrayContaining(["identifier", "active"]),
    );
  });

  // No US Core profile uses max:0, so this was only ever covered by a
  // hand-built MinStructureDefinition, never through a real package.
  it('max: "0" drops the property', () => {
    expect(schemaOf(profiled()).properties.birthDate).toBeUndefined();
  });

  it("fixed[x] pins the value: const in 3.1, single-value enum in 3.0.3", () => {
    expect(schemaOf(profiled("3.1.0")).properties.active.const).toBe(true);
    expect(schemaOf(profiled("3.0.3")).properties.active.enum).toEqual([true]);
  });

  it("resolves a core required binding through the fallback on R5", () => {
    expect([...schemaOf(profiled()).properties.gender.enum].sort()).toEqual([
      "female",
      "male",
      "other",
      "unknown",
    ]);
  });

  it("validates against the meta-schema in both OpenAPI versions", async () => {
    for (const openApiVersion of OPENAPI_VERSIONS) {
      const result = await valid(profiled(openApiVersion));
      expect(
        result.errors,
        JSON.stringify(result.errors ?? null).slice(0, 400),
      ).toBeUndefined();
    }
  });
});

describe("claim: CapabilityStatement-driven generation", () => {
  it("emits only the declared surface, on every FHIR version and OpenAPI version", async () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      for (const openApiVersion of OPENAPI_VERSIONS) {
        const statement = structuredClone(capabilityFixture) as any;
        statement.fhirVersion = FHIR_NUMBERS[fhirVersion];
        const doc = generateOpenApi({
          fhirVersion,
          openApiVersion,
          capability: parseCapabilityStatement(statement),
        }) as any;
        const label = `${fhirVersion}/${openApiVersion}`;

        // Patient declares read + search-type only.
        expect(Object.keys(doc.paths["/Patient"]), label).toEqual(["get"]);
        expect(Object.keys(doc.paths["/Patient/{id}"]), label).toEqual([
          "parameters",
          "get",
        ]);
        expect(doc.paths["/Patient/{id}/_history"], label).toBeUndefined();
        // Observation additionally declares create.
        expect(Object.keys(doc.paths["/Observation"]).sort(), label).toEqual([
          "get",
          "post",
        ]);
        // Nothing undeclared leaks in.
        expect(
          Object.keys(doc.paths).every((p) =>
            /^\/(Patient|Observation)/.test(p),
          ),
          label,
        ).toBe(true);

        const result = await valid(doc);
        expect(
          result.errors,
          `${label}: ${JSON.stringify(result.errors ?? null).slice(0, 400)}`,
        ).toBeUndefined();
      }
    }
  });
});

describe("claim: search parameters documented and tunable", () => {
  // README: "accepted codes and comparison prefixes per FHIR version; emit
  // only the ones your deployment indexes."
  it("documents accepted codes and prefixes on every FHIR version", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      const params = (
        generateOpenApi({ resources: ["Observation"], fhirVersion }) as any
      ).paths["/Observation"].get.parameters.filter((p: any) => !p.$ref);

      const status = params.find((p: any) => p.name === "status");
      expect(
        status["x-fhir-search-values"],
        `${fhirVersion}: status codes`,
      ).toContain("final");
      expect(status.description, fhirVersion).toMatch(/Accepted values:/);

      const date = params.find((p: any) => p.name === "date");
      expect(
        date["x-fhir-search-prefixes"],
        `${fhirVersion}: date prefixes`,
      ).toContain("ge");
      expect(date.description, fhirVersion).toMatch(/comparison prefix/);
    }
  });

  it("reports each version's own codes rather than a fixed list", () => {
    const codes = (fhirVersion: any) =>
      (generateOpenApi({ resources: ["Encounter"], fhirVersion }) as any).paths[
        "/Encounter"
      ].get.parameters.find((p: any) => p.name === "status")[
        "x-fhir-search-values"
      ];
    expect(codes("r4")).toContain("arrived");
    expect(codes("r5")).toContain("completed");
    expect(codes("r4")).not.toEqual(codes("r5"));
  });

  it("emits only the selected parameters, on every FHIR version", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      const emitted = (
        generateOpenApi({
          resources: ["Observation"],
          fhirVersion,
          searchParams: parseSearchParamSpec(["minimal,+based-on"]),
        } as any) as any
      ).paths["/Observation"].get.parameters.filter((p: any) => !p.$ref);
      const all = (
        generateOpenApi({ resources: ["Observation"], fhirVersion }) as any
      ).paths["/Observation"].get.parameters.filter((p: any) => !p.$ref);

      expect(emitted.length, fhirVersion).toBeLessThan(all.length);
      expect(
        emitted.map((p: any) => p.name),
        fhirVersion,
      ).toContain("based-on");
    }
  });
});

describe("claim: merge mode and drift guard", () => {
  it("preserves hand-written content and detects drift, on every FHIR version", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      const doc = generateOpenApi({ resources: ["Patient"], fhirVersion });
      const generated = stringifyDocument(doc);

      const handWritten = [
        "# a comment the author wrote",
        `openapi: ${(doc as any).openapi}`,
        "info:",
        "  title: Hand maintained",
        '  version: "1"',
        "paths: {}",
        "",
      ].join("\n");

      const merged = mergeIntoYaml(doc, handWritten, { force: true });
      expect(merged, fhirVersion).toContain("# a comment the author wrote");

      // A spec matching generation is in sync; the hand-written one is not.
      expect(diffAgainstYaml(doc, generated).inSync, fhirVersion).toBe(true);
      expect(diffAgainstYaml(doc, handWritten).inSync, fhirVersion).toBe(false);
    }
  });
});
