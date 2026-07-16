import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import {
  generateOpenApi,
  loadCapabilityStatement,
  parseCapabilityStatement,
} from "../src/index.js";

const FIXTURE = path.resolve(__dirname, "fixtures/capabilitystatement-minimal.json");
const statement = () => JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

function gen(extra: Record<string, unknown> = {}) {
  return generateOpenApi({
    fhirVersion: "r4",
    capability: parseCapabilityStatement(statement()),
    ...extra,
  }) as any;
}

describe("parseCapabilityStatement", () => {
  it("extracts per-resource interactions, search params, and operations", () => {
    const cap = parseCapabilityStatement(statement());
    expect(cap.fhirVersion).toBe("4.0.1");
    const patient = cap.resources.find((r) => r.type === "Patient")!;
    expect([...patient.interactions].sort()).toEqual(["read", "search-type"]);
    expect([...patient.searchParamCodes].sort()).toEqual(["birthdate", "name"]);
    expect(patient.operations.has("everything")).toBe(true);
  });

  it("rejects non-CapabilityStatement input and empty statements", () => {
    expect(() => parseCapabilityStatement({ resourceType: "Patient" })).toThrow(
      /Expected a CapabilityStatement/,
    );
    expect(() =>
      parseCapabilityStatement({ resourceType: "CapabilityStatement", rest: [] }),
    ).toThrow(/no server resources/);
  });
});

describe("CapabilityStatement-driven generation", () => {
  it("derives the resource set from the statement", () => {
    const doc = gen();
    expect(Object.keys(doc.paths)).toContain("/Patient");
    expect(Object.keys(doc.paths)).toContain("/Observation");
    expect(doc.tags.map((t: any) => t.name).sort()).toEqual(["Observation", "Patient"]);
  });

  it("emits only the declared interactions per resource", () => {
    const doc = gen();
    // Patient declares read + search only.
    expect(Object.keys(doc.paths["/Patient"])).toEqual(["get"]);
    expect(Object.keys(doc.paths["/Patient/{id}"])).toEqual(["parameters", "get"]);
    expect(doc.paths["/Patient/{id}/_history"]).toBeUndefined();
    expect(doc.paths["/Patient/_history"]).toBeUndefined();
    // Observation declares read + create + search.
    expect(Object.keys(doc.paths["/Observation"]).sort()).toEqual(["get", "post"]);
    expect(doc.paths["/Observation/{id}"].put).toBeUndefined();
  });

  it("restricts search parameters to the declared codes", () => {
    const params = gen()
      .paths["/Patient"].get.parameters.filter((p: any) => p.name && !p.$ref)
      .map((p: any) => p.name);
    expect(params.sort()).toEqual(["birthdate", "name"]);
    // A non-declared Patient search param (e.g. "gender") is absent.
    expect(params).not.toContain("gender");
  });

  it("emits declared operations mapped to known OperationDefinitions", () => {
    const doc = gen();
    expect(doc.paths["/Patient/{id}/$everything"]).toBeDefined();
    // Observation declared no operations.
    expect(Object.keys(doc.paths).some((p) => p.startsWith("/Observation/$"))).toBe(false);
  });

  it("narrows to explicitly requested resources when both are given", () => {
    const doc = gen({ resources: ["Patient"] });
    expect(doc.paths["/Patient"]).toBeDefined();
    expect(doc.paths["/Observation"]).toBeUndefined();
  });

  it("skips resource types the FHIR version does not define", () => {
    const withUnknown = statement();
    withUnknown.rest[0].resource.push({ type: "MadeUpResource", interaction: [{ code: "read" }] });
    const doc = generateOpenApi({
      fhirVersion: "r4",
      capability: parseCapabilityStatement(withUnknown),
    }) as any;
    expect(doc.paths["/MadeUpResource"]).toBeUndefined();
    expect(doc.paths["/Patient"]).toBeDefined();
  });

  it("rejects a FHIR-version mismatch", () => {
    expect(() =>
      generateOpenApi({ fhirVersion: "r5", capability: parseCapabilityStatement(statement()) }),
    ).toThrow(/targets FHIR 4\.0\.1/);
  });

  it("validates against the OpenAPI meta-schema for both targets", async () => {
    for (const openApiVersion of ["3.0.3", "3.1.0"] as const) {
      const doc = gen({ openApiVersion });
      const result = await new Validator().validate(structuredClone(doc));
      expect(result.errors, JSON.stringify(result.errors ?? null).slice(0, 800)).toBeUndefined();
      expect(result.valid).toBe(true);
    }
  });

  it("is deterministic", () => {
    expect(gen()).toEqual(gen());
  });
});

describe("loadCapabilityStatement", () => {
  it("loads from a local file", async () => {
    const cap = await loadCapabilityStatement(FIXTURE);
    expect(cap.resources.map((r) => r.type).sort()).toEqual(["Observation", "Patient"]);
  });

  it("fetches from a URL, appending /metadata to a base URL", async () => {
    const body = JSON.stringify(statement());
    let requestedUrl = "";
    const fetchImpl = (async (url: string) => {
      requestedUrl = url;
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const cap = await loadCapabilityStatement("https://fhir.example.org/r4", { fetchImpl });
    expect(requestedUrl).toBe("https://fhir.example.org/r4/metadata");
    expect(cap.resources.length).toBe(2);
  });

  it("surfaces an HTTP error", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(
      loadCapabilityStatement("https://fhir.example.org/r4/metadata", { fetchImpl }),
    ).rejects.toThrow(/503/);
  });
});

describe("CapabilityStatement CLI end-to-end", () => {
  const CLI = path.resolve(__dirname, "../dist/cli.js");
  function run(args: string[], expectFailure = false) {
    try {
      return { stdout: execFileSync("node", [CLI, ...args], { encoding: "utf8" }), code: 0 };
    } catch (e: any) {
      if (!expectFailure) throw new Error(`CLI failed: ${e.stderr}`);
      return { stdout: e.stdout ?? "", code: e.status ?? 1 };
    }
  }

  it("generates and checks a capability spec with no resource arguments", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fhir-oas-cap-"));
    const out = path.join(dir, "server.yaml");
    try {
      run(["generate", "--fhir-version", "r4", "--capability", FIXTURE, "-o", out]);
      expect(fs.readFileSync(out, "utf8")).toContain("/Patient");
      const inSync = run(["check", "--fhir-version", "r4", "--capability", FIXTURE, "--file", out]);
      expect(inSync.code).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
