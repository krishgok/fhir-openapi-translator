import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  diffAgainstYaml,
  generateOpenApi,
  mergeIntoYaml,
  stringifyDocument,
  MergeConflictError,
} from "../src/index.js";

const patient = () => generateOpenApi({ resources: ["Patient"], fhirVersion: "r4" });
const observation = () => generateOpenApi({ resources: ["Observation"], fhirVersion: "r4" });

describe("mergeIntoYaml", () => {
  it("treats an empty file as a fresh write", () => {
    const text = mergeIntoYaml(patient(), "");
    const parsed = parse(text);
    expect(parsed.openapi).toBe("3.0.3");
    expect(parsed.components.schemas.Patient).toBeDefined();
  });

  it("adds new resources alongside existing content and preserves comments", () => {
    const existing = "# team API spec\n" + stringifyDocument(patient());
    const merged = mergeIntoYaml(observation(), existing);
    expect(merged).toContain("# team API spec");
    const parsed = parse(merged);
    expect(parsed.components.schemas.Patient).toBeDefined();
    expect(parsed.components.schemas.Observation).toBeDefined();
    expect(parsed.paths["/Patient"]).toBeDefined();
    expect(parsed.paths["/Observation"]).toBeDefined();
    expect(parsed.tags.map((t: { name: string }) => t.name)).toEqual([
      "Patient",
      "Observation",
    ]);
  });

  it("is idempotent for identical content", () => {
    const existing = stringifyDocument(patient());
    const merged = mergeIntoYaml(patient(), existing);
    expect(parse(merged)).toEqual(parse(existing));
  });

  it("fails on conflicting entries without force, listing the locations", () => {
    const existing = stringifyDocument(patient());
    const conflicting = patient();
    (conflicting.components as any).schemas.Patient = { type: "object" };
    let error: MergeConflictError | undefined;
    try {
      mergeIntoYaml(conflicting, existing);
    } catch (e) {
      error = e as MergeConflictError;
    }
    expect(error).toBeInstanceOf(MergeConflictError);
    expect(error!.conflicts.map((c) => c.location)).toEqual(["components.schemas.Patient"]);
    // Nothing was modified: original text still parses to the original doc.
    expect(parse(existing).components.schemas.Patient.properties).toBeDefined();
  });

  it("overwrites conflicting entries with force", () => {
    const existing = stringifyDocument(patient());
    const conflicting = patient();
    (conflicting.components as any).schemas.Patient = { type: "object" };
    const merged = mergeIntoYaml(conflicting, existing, { force: true });
    expect(parse(merged).components.schemas.Patient).toEqual({ type: "object" });
  });

  it("refuses to merge across OpenAPI versions", () => {
    const existing = stringifyDocument(patient());
    const v31 = generateOpenApi({
      resources: ["Observation"],
      fhirVersion: "r4",
      openApiVersion: "3.1.0",
    });
    expect(() => mergeIntoYaml(v31, existing)).toThrow(/OpenAPI version mismatch/);
  });

  it("diffAgainstYaml reports in-sync, missing, and changed states", () => {
    const existing = stringifyDocument(patient());

    expect(diffAgainstYaml(patient(), existing).inSync).toBe(true);

    const withObservation = diffAgainstYaml(observation(), existing);
    expect(withObservation.inSync).toBe(false);
    expect(withObservation.missing).toContain("components.schemas.Observation");
    expect(withObservation.missing).toContain("paths./Observation");
    expect(withObservation.changed).toEqual([]);

    const conflicting = patient();
    (conflicting.components as any).schemas.Patient = { type: "object" };
    const drifted = diffAgainstYaml(conflicting, existing);
    expect(drifted.inSync).toBe(false);
    expect(drifted.changed).toEqual(["components.schemas.Patient"]);

    expect(diffAgainstYaml(patient(), "").inSync).toBe(false);
  });

  it("keeps existing info/servers over generated ones", () => {
    const existing = stringifyDocument({
      openapi: "3.0.3",
      info: { title: "Hand-written API", version: "9.9.9" },
      paths: {},
    });
    const merged = parse(mergeIntoYaml(patient(), existing));
    expect(merged.info.title).toBe("Hand-written API");
  });
});
