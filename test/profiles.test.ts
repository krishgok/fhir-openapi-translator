import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Validator } from "@seriousme/openapi-schema-validator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateOpenApi, loadIg, loadIgSync } from "../src/index.js";
import { applyProfile, buildCoreValueSetFallback } from "../src/ig/profile.js";
import { buildRegistryFromStructureDefinitions } from "../src/backends/structureDefinition.js";
import { emitStructureDefinitionSchemas } from "../src/ir/structureWalker.js";
import type { MinStructureDefinition } from "../src/definitions.js";

const IG_DIR = path.resolve(__dirname, "fixtures/us-core");

function gen(extra: Record<string, unknown> = {}) {
  return generateOpenApi({
    resources: ["Patient"],
    fhirVersion: "r4",
    ig: IG_DIR,
    profiles: ["us-core-patient"],
    ...extra,
  }) as any;
}

describe("profile application (US Core Patient fixture)", () => {
  it("emits a named profile schema referenced from the base paths", () => {
    const doc = gen();
    const profile = doc.components.schemas.USCorePatientProfile;
    expect(profile).toBeDefined();
    expect(profile["x-fhir-profile"]).toBe(
      "http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient",
    );
    // Base resource schema is not emitted (per the named-profile decision).
    expect(doc.components.schemas.Patient).toBeUndefined();
    // Paths stay at /Patient but reference the profiled schema.
    expect(doc.paths["/Patient"]).toBeDefined();
    const bodyRef =
      doc.paths["/Patient"].post.requestBody.content["application/fhir+json"].schema.$ref;
    expect(bodyRef).toBe("#/components/schemas/USCorePatientProfile");
  });

  it("applies tightened cardinality as required properties", () => {
    const profile = gen().components.schemas.USCorePatientProfile;
    expect(profile.required).toEqual(expect.arrayContaining(["identifier", "name", "gender"]));
  });

  it("keeps resourceType as the base type, not the profile name", () => {
    const rt = gen().components.schemas.USCorePatientProfile.properties.resourceType;
    expect(rt.enum).toEqual(["Patient"]);
  });

  it("resolves a core-defined required binding to an enum via the core fallback", () => {
    const gender = gen().components.schemas.USCorePatientProfile.properties.gender;
    expect([...gender.enum].sort()).toEqual(["female", "male", "other", "unknown"]);
  });

  it("surfaces must-support as a non-enforced constraint note", () => {
    const name = gen().components.schemas.USCorePatientProfile.properties.name;
    expect(name.description).toMatch(/must-support/);
  });

  it("narrows ResourceList to the profiled schema", () => {
    const resourceList = JSON.stringify(gen().components.schemas.ResourceList);
    expect(resourceList).toContain("USCorePatientProfile");
  });

  it("validates against the OpenAPI meta-schema for both targets", async () => {
    for (const openApiVersion of ["3.0.3", "3.1.0"] as const) {
      const doc = gen({ openApiVersion });
      const result = await new Validator().validate(structuredClone(doc));
      expect(result.errors, JSON.stringify(result.errors ?? null).slice(0, 800)).toBeUndefined();
      expect(result.valid).toBe(true);
    }
  });

  // Regression: only us-core-patient was ever exercised. us-core-blood-pressure
  // carries contentReferences in the absolute canonical form that IG snapshot
  // generators emit ("http://.../Observation#Observation.referenceRange"),
  // which failed generation outright. Every profile in the package must apply.
  it("applies every resource profile in the package", () => {
    const ig = loadIgSync(IG_DIR);
    expect(ig.profiles.length).toBeGreaterThan(1);

    for (const profile of ig.profiles) {
      const doc = generateOpenApi({
        resources: [profile.type],
        fhirVersion: "r4",
        ig: IG_DIR,
        profiles: [profile.id ?? profile.name],
      }) as any;

      const schemaName = Object.keys(doc.components.schemas).find(
        (n) => doc.components.schemas[n]["x-fhir-profile"] === profile.url,
      );
      expect(schemaName, `${profile.id}: no schema carrying x-fhir-profile`).toBeDefined();
      // Every $ref in the document must resolve to an emitted schema.
      const refs = [...JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([^"]+)"/g)]
        .map((m) => m[1])
        .filter((r): r is string => !!r);
      for (const ref of new Set(refs)) {
        expect(doc.components.schemas[ref], `${profile.id}: dangling $ref ${ref}`).toBeDefined();
      }
    }
  });
});

describe("profile slicing does not corrupt cardinality", () => {
  // A sliced element appears several times under one path: the slicing root
  // (Observation.component, max *) then each named slice (…:systolic, max 1)
  // and that slice's children, which reuse the root's paths. Keyed by path the
  // last entry won, so slices overwrote their own root and US Core Blood
  // Pressure emitted `component` as a single object instead of an array.
  it("keeps a sliced element an array", () => {
    const doc = generateOpenApi({
      resources: ["Observation"],
      fhirVersion: "r4",
      ig: IG_DIR,
      profiles: ["us-core-blood-pressure"],
    }) as any;
    const name = Object.keys(doc.components.schemas).find(
      (n) => doc.components.schemas[n]["x-fhir-profile"],
    )!;
    const component = doc.components.schemas[name].properties.component;
    expect(component.type, "sliced component must stay an array").toBe("array");
    expect(component.items?.$ref).toBeDefined();
  });

  // The general rule, checked against the definitions rather than by hand: a
  // profile may only turn a base array into a scalar when its own unsliced
  // element says so (US Core does narrow Device.udiCarrier to 0..1).
  it("only narrows cardinality where the profile's own element narrows it", () => {
    const ig = loadIgSync(IG_DIR);
    const problems: string[] = [];

    for (const profile of ig.profiles) {
      const base = (generateOpenApi({ resources: [profile.type], fhirVersion: "r4" }) as any)
        .components.schemas[profile.type];
      const doc = generateOpenApi({
        resources: [profile.type],
        fhirVersion: "r4",
        ig: IG_DIR,
        profiles: [profile.id ?? profile.name],
      }) as any;
      const name = Object.keys(doc.components.schemas).find(
        (n) => doc.components.schemas[n]["x-fhir-profile"] === profile.url,
      )!;
      const emitted = doc.components.schemas[name];

      for (const [property, baseSchema] of Object.entries<any>(base.properties)) {
        const profiled = emitted.properties[property];
        if (!profiled) continue;
        if ((baseSchema.type === "array") === (profiled.type === "array")) continue;

        // Divergence is only legitimate if the profile's own element says max 1.
        const element = (profile as any).definition?.elements?.find(
          (el: any) => el.path === `${profile.type}.${property}`,
        );
        if (element?.max !== "1") {
          problems.push(`${profile.id}.${property}: base array, profile scalar, max=${element?.max}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("IG loading", () => {
  let tarball: string;
  let tmpDir: string;

  beforeAll(() => {
    // Pack the fixture directory into a .tgz to exercise tarball loading.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fhir-oas-ig-test-"));
    tarball = path.join(tmpDir, "us-core.tgz");
    execFileSync("tar", ["-czf", tarball, "-C", IG_DIR, "package"], { stdio: "pipe" });
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("loads from an unpacked directory", () => {
    const ig = loadIgSync(IG_DIR);
    expect(ig.name).toBe("hl7.fhir.us.core");
    expect(ig.fhirVersion).toBe("r4");
    expect(ig.profiles.map((p) => p.type)).toEqual(
      expect.arrayContaining(["Patient", "Observation"]),
    );
  });

  it("loads from a tarball", async () => {
    const ig = await loadIg(tarball);
    expect(ig.profiles.some((p) => p.url.endsWith("us-core-patient"))).toBe(true);
  });

  it("fetches from the registry with a mocked fetch and caches the tarball", async () => {
    const bytes = fs.readFileSync(tarball);
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(bytes, { status: 200 });
    }) as unknown as typeof fetch;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "fhir-oas-cache-"));
    try {
      const opts = { fetchImpl, cacheDir };
      const first = await loadIg("hl7.fhir.us.core@5.0.1", opts);
      const second = await loadIg("hl7.fhir.us.core@5.0.1", opts);
      expect(first.name).toBe("hl7.fhir.us.core");
      expect(second.name).toBe("hl7.fhir.us.core");
      expect(calls).toBe(1); // second load served from cache
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("surfaces a registry 404 as an actionable error", async () => {
    const fetchImpl = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;
    await expect(
      loadIg("no.such.package@1.0.0", { fetchImpl, cacheDir: os.tmpdir() }),
    ).rejects.toThrow(/404|download the package/);
  });
});

describe("profile error handling and constraint edge cases", () => {
  it("rejects a FHIR-version mismatch", () => {
    expect(() =>
      generateOpenApi({
        resources: ["Patient"],
        fhirVersion: "r5",
        ig: IG_DIR,
        profiles: ["us-core-patient"],
      }),
    ).toThrow(/targets FHIR R4/i);
  });

  it("rejects --profile without --ig and unknown profiles", () => {
    expect(() =>
      generateOpenApi({ resources: ["Patient"], fhirVersion: "r4", profiles: ["x"] }),
    ).toThrow(/requires --ig|point at the IG/i);
    expect(() =>
      generateOpenApi({
        resources: ["Patient"],
        fhirVersion: "r4",
        ig: IG_DIR,
        profiles: ["not-a-profile"],
      }),
    ).toThrow(/not found/i);
  });

  it("drops max:0 elements and pins fixed values to a const (synthetic profile)", () => {
    // A minimal synthetic profile exercises constraints US Core doesn't apply
    // at the top level: an element removed (max 0) and a fixed value.
    const synthetic: MinStructureDefinition = {
      name: "TinyPatient",
      url: "http://example.org/StructureDefinition/tiny-patient",
      kind: "resource",
      type: "Patient",
      abstract: false,
      elements: [
        { path: "Patient", min: 0, max: "*" },
        { path: "Patient.gender", min: 1, max: "1", types: [{ code: "code" }], fixed: "female" },
        { path: "Patient.birthDate", min: 0, max: "0", types: [{ code: "date" }] },
        { path: "Patient.active", min: 0, max: "1", types: [{ code: "boolean" }] },
      ],
    };
    const registry = buildRegistryFromStructureDefinitions("r4");
    emitStructureDefinitionSchemas(synthetic, registry.definitions, {
      rootName: "TinyPatient",
      isResourceRoot: true,
      resourceDisplayName: "Patient",
      profile: true,
    });
    const schema = registry.definitions.get("TinyPatient") as any;
    expect(schema.properties.gender.const).toBe("female");
    expect(schema.properties.birthDate).toBeUndefined(); // max 0 removed
    expect(schema.properties.active).toBeDefined();
    expect(schema.required).toContain("gender");
  });

  it("buildCoreValueSetFallback resolves administrative-gender", () => {
    const resolve = buildCoreValueSetFallback("r4");
    const codes = resolve("http://hl7.org/fhir/ValueSet/administrative-gender");
    expect(codes && [...codes].sort()).toEqual(["female", "male", "other", "unknown"]);
    expect(resolve("http://example.org/ValueSet/nope")).toBeUndefined();
  });

  it("applyProfile is deterministic", () => {
    const a = buildRegistryFromStructureDefinitions("r4");
    const b = buildRegistryFromStructureDefinitions("r4");
    const ig = loadIgSync(IG_DIR);
    applyProfile(ig, "us-core-patient", a);
    applyProfile(ig, "us-core-patient", b);
    expect(a.definitions.get("USCorePatientProfile")).toEqual(
      b.definitions.get("USCorePatientProfile"),
    );
  });
});
