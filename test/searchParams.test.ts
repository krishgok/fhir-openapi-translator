/**
 * Search parameter fidelity and control.
 *
 * Three gaps motivated these: prefix-capable parameters (date/number/quantity)
 * advertised nothing about prefixes; token parameters over a required binding
 * were enumerated only when HL7's hand-written description happened to list
 * the codes (Encounter-status did, Observation-status did not); and there was
 * no way to emit fewer search parameters without a full CapabilityStatement.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { FHIR_VERSIONS, generateOpenApi, listResources } from "../src/index.js";
import { parseSearchParamSpec } from "../src/searchParams.js";
import type { MinStructureDefinition } from "../src/definitions.js";

const ROOT = path.resolve(__dirname, "..");
const structureDefs = (v: string): MinStructureDefinition[] =>
  JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(ROOT, `definitions/${v}/structure-definitions.json.gz`))).toString(),
  );

const RESOURCES = ["Observation", "Encounter", "Patient", "Condition", "MedicationRequest"];

const searchParams = (resource: string, fhirVersion: string, extra: Record<string, unknown> = {}) =>
  (
    generateOpenApi({ resources: [resource], fhirVersion: fhirVersion as any, ...extra }) as any
  ).paths[`/${resource}`].get.parameters.filter((p: any) => !p.$ref);

describe("search parameters: derived metadata", () => {
  it("advertises comparison prefixes on every prefix-capable parameter", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const fhirVersion of FHIR_VERSIONS) {
      for (const resource of RESOURCES) {
        for (const p of searchParams(resource, fhirVersion)) {
          const prefixable = ["date", "number", "quantity"].includes(p["x-fhir-search-type"]);
          const label = `${fhirVersion}/${resource}.${p.name}`;
          if (!prefixable) {
            if (p["x-fhir-search-prefixes"]) problems.push(`${label}: prefixes on a non-ordered type`);
            continue;
          }
          checked++;
          expect(p["x-fhir-search-prefixes"], label).toEqual([
            "eq", "ne", "gt", "lt", "ge", "le", "sa", "eb", "ap",
          ]);
          if (!/comparison prefix/.test(p.description)) problems.push(`${label}: prefixes undocumented`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(30);
  });

  /** The consistency the README promises: same kind of parameter, same treatment. */
  it("enumerates every token parameter bound to a required ValueSet, uniformly", () => {
    const problems: string[] = [];
    let enumerated = 0;
    for (const fhirVersion of FHIR_VERSIONS) {
      const bound = new Map<string, string[]>();
      for (const sd of structureDefs(fhirVersion)) {
        for (const el of sd.elements) {
          if (el.binding?.strength === "required" && el.binding.codes?.length) {
            bound.set(el.path, el.binding.codes);
          }
        }
      }
      for (const resource of RESOURCES) {
        for (const p of searchParams(resource, fhirVersion)) {
          if (p["x-fhir-search-type"] !== "token") continue;
          const expected = bound.get(`${resource}.${p.name}`);
          const label = `${fhirVersion}/${resource}.${p.name}`;
          if (!expected) continue;
          enumerated++;
          // Machine-readable and prose must agree, on every such parameter.
          if (JSON.stringify(p["x-fhir-search-values"]) !== JSON.stringify(expected)) {
            problems.push(`${label}: x-fhir-search-values != binding codes`);
          }
          if (!p.description.includes("Accepted values:")) {
            problems.push(`${label}: codes absent from description`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(enumerated).toBeGreaterThan(5);
  });

  // The original report: Encounter listed its codes, Observation did not,
  // because HL7 writes the two descriptions differently.
  it("treats Encounter.status and Observation.status alike", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      for (const resource of ["Encounter", "Observation"]) {
        const status = searchParams(resource, fhirVersion).find((p: any) => p.name === "status");
        expect(status["x-fhir-search-values"]?.length, `${fhirVersion}/${resource}`).toBeGreaterThan(3);
        expect(status.description, `${fhirVersion}/${resource}`).toMatch(/Accepted values:/);
      }
    }
  });

  it("reports version-specific codes, not one version's", () => {
    const codesFor = (v: string) =>
      searchParams("Encounter", v).find((p: any) => p.name === "status")["x-fhir-search-values"];
    // R5 reworked the encounter status codes; R4's list must not leak into R5.
    expect(codesFor("r4")).toContain("arrived");
    expect(codesFor("r5")).not.toContain("arrived");
    expect(codesFor("r5")).toContain("completed");
    expect(codesFor("r4")).not.toContain("completed");
  });

  /**
   * The safety invariant behind x-fhir-search-values: a hard `enum` would
   * reject the comma-OR (`status=final,amended`), `system|code` and
   * `:modifier` forms FHIR search permits.
   */
  it("never constrains a search parameter with enum", () => {
    const offenders: string[] = [];
    for (const fhirVersion of FHIR_VERSIONS) {
      for (const resource of RESOURCES) {
        for (const p of searchParams(resource, fhirVersion)) {
          if (p.schema?.enum) offenders.push(`${fhirVersion}/${resource}.${p.name}`);
          if (p.schema?.type !== "string") offenders.push(`${fhirVersion}/${resource}.${p.name}: not a string`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("search parameters: --search-params selection", () => {
  const names = (resource: string, v: string, searchParams: unknown) =>
    (
      generateOpenApi({ resources: [resource], fhirVersion: v as any, searchParams } as any) as any
    ).paths[`/${resource}`].get.parameters.filter((p: any) => !p.$ref).map((p: any) => p.name);

  it("applies presets on every FHIR version", () => {
    for (const fhirVersion of FHIR_VERSIONS) {
      const all = names("Observation", fhirVersion, parseSearchParamSpec(["all"]));
      const minimal = names("Observation", fhirVersion, parseSearchParamSpec(["minimal"]));
      const none = names("Observation", fhirVersion, parseSearchParamSpec(["none"]));
      expect(none, fhirVersion).toEqual([]);
      expect(minimal.length, fhirVersion).toBeGreaterThan(0);
      expect(minimal.length, fhirVersion).toBeLessThan(all.length);
      // minimal is a subset of all, never invented codes.
      expect(minimal.every((n: string) => all.includes(n)), fhirVersion).toBe(true);
    }
  });

  /**
   * The reason `minimal` is tiered rather than a flat curated list: a resource
   * that names none of the common codes (Linkage: author/item/source) would
   * otherwise select nothing, making `minimal` indistinguishable from `none`.
   */
  it("never empties a resource that defines any search parameter", () => {
    const problems: string[] = [];
    for (const fhirVersion of FHIR_VERSIONS) {
      for (const resource of listResources(fhirVersion)) {
        const all = searchParams(resource, fhirVersion).length;
        if (all === 0) continue; // Binary, OperationOutcome: nothing to select
        const kept = searchParams(resource, fhirVersion, {
          searchParams: parseSearchParamSpec(["minimal"]),
        }).length;
        if (kept === 0) problems.push(`${fhirVersion}/${resource}: ${all} params, minimal kept 0`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("falls back to direct top-level parameters where no common code applies", () => {
    // Linkage names no common code. Its three parameters are `author`
    // (Linkage.author, a top-level element) and `item`/`source` (both
    // Linkage.item.resource, nested). Only the direct one is selected —
    // the tier exists to avoid selecting nothing, not to select everything.
    expect(searchParams("Linkage", "r4").map((p: any) => p.name)).toEqual([
      "author", "item", "source",
    ]);
    const kept = searchParams("Linkage", "r4", {
      searchParams: parseSearchParamSpec(["minimal"]),
    }).map((p: any) => p.name);
    expect(kept).toEqual(["author"]);
  });

  it("still reduces substantially where common codes do apply", () => {
    const all = searchParams("Observation", "r4").length;
    const kept = searchParams("Observation", "r4", {
      searchParams: parseSearchParamSpec(["minimal"]),
    }).length;
    expect(all).toBeGreaterThan(30);
    expect(kept).toBeLessThan(all / 2);
  });

  it("applies an explicit list and per-resource scoping", () => {
    expect(names("Observation", "r4", parseSearchParamSpec(["code,date,subject"]))).toEqual([
      "code", "date", "subject",
    ]);
    const spec = parseSearchParamSpec(["Patient:name,birthdate", "Observation:code"]);
    expect(names("Patient", "r4", spec)).toEqual(["birthdate", "name"]);
    expect(names("Observation", "r4", spec)).toEqual(["code"]);
  });

  it("falls back to the unscoped selection for unlisted resources", () => {
    const spec = parseSearchParamSpec(["none", "Observation:code"]);
    expect(names("Observation", "r4", spec)).toEqual(["code"]);
    expect(names("Patient", "r4", spec)).toEqual([]);
  });

  /**
   * No fixed rule can know that Observation.based-on, CarePlan.goal or
   * MedicationStatement.adherence matter for their resource — each is central
   * to it and none is common enough to curate globally. Presets are therefore
   * a starting point, not a take-it-or-leave-it list.
   */
  it("tunes a preset with +add and -remove", () => {
    const base = names("Observation", "r4", parseSearchParamSpec(["minimal"]));
    expect(base).not.toContain("based-on");

    const added = names("Observation", "r4", parseSearchParamSpec(["minimal,+based-on"]));
    expect(added).toEqual([...base, "based-on"].sort());

    const removed = names("Observation", "r4", parseSearchParamSpec(["minimal,-category"]));
    expect(removed).toEqual(base.filter((c: string) => c !== "category"));

    // The reviewer's other examples, on the resources they named.
    expect(names("CarePlan", "r4", parseSearchParamSpec(["minimal,+goal,+condition"]))).toEqual(
      expect.arrayContaining(["goal", "condition"]),
    );
    expect(
      names("MedicationStatement", "r5", parseSearchParamSpec(["minimal,+adherence"])),
    ).toContain("adherence");
  });

  // Each form the reference documents, asserted so the docs cannot drift.
  it("accepts any number of adjustments, mixed in any order", () => {
    const base = names("Observation", "r4", parseSearchParamSpec(["minimal"]));

    const many = names(
      "Observation",
      "r4",
      parseSearchParamSpec(["minimal,+based-on,+derived-from,+focus,+method"]),
    );
    expect(many).toEqual([...base, "based-on", "derived-from", "focus", "method"].sort());

    const mixed = names(
      "Observation",
      "r4",
      parseSearchParamSpec(["minimal,+based-on,-category,+focus,-code"]),
    );
    expect(mixed).toContain("based-on");
    expect(mixed).toContain("focus");
    expect(mixed).not.toContain("category");
    expect(mixed).not.toContain("code");

    // Order is irrelevant: the same adjustments give the same result.
    expect(
      names("Observation", "r4", parseSearchParamSpec(["minimal,-code,+focus,-category,+based-on"])),
    ).toEqual(mixed);

    // `none` plus additions builds a set up from nothing.
    expect(names("Observation", "r4", parseSearchParamSpec(["none,+code,+date"]))).toEqual([
      "code", "date",
    ]);
  });

  it("supports everything-except via all with removals", () => {
    const all = names("Observation", "r4", parseSearchParamSpec(["all"]));
    const fewer = names("Observation", "r4", parseSearchParamSpec(["all,-code,-date"]));
    expect(fewer).toEqual(all.filter((c: string) => c !== "code" && c !== "date"));
    expect(fewer.length).toBe(all.length - 2);
  });

  it("applies adjustments per resource", () => {
    const spec = parseSearchParamSpec(["Patient:minimal", "Observation:minimal,+based-on"]);
    expect(names("Patient", "r4", spec)).not.toContain("based-on");
    expect(names("Observation", "r4", spec)).toContain("based-on");
  });

  it("rejects unknown codes and contradictory specs", () => {
    // A typo in an adjustment must fail as loudly as one in a plain list.
    expect(() => names("Observation", "r4", parseSearchParamSpec(["minimal,+basedon"]))).toThrow(
      /no search parameter "basedon"/,
    );
    expect(() => names("Observation", "r4", parseSearchParamSpec(["minimal,-nope"]))).toThrow(
      /no search parameter "nope"/,
    );
    expect(() => parseSearchParamSpec(["code,minimal"])).toThrow(/must come first/);
    expect(() => parseSearchParamSpec(["minimal,based-on"])).toThrow(/mixes the preset/);
    expect(() => parseSearchParamSpec(["minimal,+"])).toThrow(/names no parameter/);

    expect(() => names("Observation", "r4", parseSearchParamSpec(["cod"]))).toThrow(
      /no search parameter "cod"/,
    );
    expect(() => parseSearchParamSpec(["a,b", "c,d"])).toThrow(/more than one unscoped/);
    expect(() => parseSearchParamSpec(["Patient:name", "Patient:gender"])).toThrow(/more than once/);
  });

  it("intersects with a CapabilityStatement rather than overriding it", () => {
    const capability = {
      fhirVersion: "4.0.1",
      resources: [
        {
          type: "Observation",
          interactions: new Set(["read", "search-type"]),
          searchParamCodes: new Set(["code", "date"]),
          operations: new Set<string>(),
        },
      ],
    };
    const doc = generateOpenApi({
      fhirVersion: "r4",
      capability,
      searchParams: parseSearchParamSpec(["date,subject"]),
    } as any) as any;
    const emitted = doc.paths["/Observation"].get.parameters
      .filter((p: any) => !p.$ref)
      .map((p: any) => p.name);
    // "code" is server-supported but not requested; "subject" requested but
    // not server-supported. Only the intersection survives.
    expect(emitted).toEqual(["date"]);
  });

  it("keeps the common result parameters whatever the selection", () => {
    const doc = generateOpenApi({
      resources: ["Observation"],
      fhirVersion: "r4",
      searchParams: parseSearchParamSpec(["none"]),
    } as any) as any;
    const refs = doc.paths["/Observation"].get.parameters.filter((p: any) => p.$ref);
    expect(refs.length).toBeGreaterThan(5);
    expect(doc.components.parameters._count).toBeDefined();
  });

  it("works through the CLI", () => {
    const out = execFileSync(
      process.execPath,
      [path.join(ROOT, "dist/cli.js"), "generate", "Observation", "-f", "r4",
       "--search-params", "code,date", "--format", "json"],
      { encoding: "utf8" },
    );
    const emitted = JSON.parse(out).paths["/Observation"].get.parameters
      .filter((p: any) => !p.$ref)
      .map((p: any) => p.name);
    expect(emitted).toEqual(["code", "date"]);
  });
});
