import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const CLI = path.resolve(__dirname, "../dist/cli.js");

function run(args: string[], expectFailure = false): { stdout: string; code: number } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8" });
    return { stdout, code: 0 };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    if (!expectFailure) {
      throw new Error(`CLI failed (${e.status}): ${e.stderr}`);
    }
    return { stdout: e.stdout ?? "", code: e.status ?? 1 };
  }
}

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fhir-oas-test-"));
  return path.join(dir, name);
}

describe("fhir-oas CLI (requires `npm run build`)", () => {
  it("generates YAML to stdout", () => {
    const { stdout } = run(["generate", "Patient", "--fhir-version", "r4"]);
    const doc = parse(stdout);
    expect(doc.openapi).toBe("3.0.3");
    expect(doc.components.schemas.Patient).toBeDefined();
  });

  it("writes JSON with --format json and accepts 3.1", () => {
    const out = tmpFile("patient.json");
    run([
      "generate", "Patient",
      "--fhir-version", "r5",
      "--openapi-version", "3.1",
      "--format", "json",
      "-o", out,
    ]);
    const doc = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe("5.0.0");
  });

  it("merges into an existing file, failing on conflicts unless --force", () => {
    const out = tmpFile("api.yaml");
    run(["generate", "Patient", "--fhir-version", "r4", "-o", out]);
    run(["generate", "Observation", "--fhir-version", "r4", "--merge-into", out]);
    const doc = parse(fs.readFileSync(out, "utf8"));
    expect(doc.components.schemas.Patient).toBeDefined();
    expect(doc.components.schemas.Observation).toBeDefined();

    // Same resource, different trim -> conflicting schema bodies.
    const conflict = run(
      ["generate", "Patient", "--fhir-version", "r4", "--exclude-narrative", "--merge-into", out],
      true,
    );
    expect(conflict.code).toBe(1);

    run(["generate", "Patient", "--fhir-version", "r4", "--exclude-narrative", "--force", "--merge-into", out]);
    const forced = parse(fs.readFileSync(out, "utf8"));
    expect(forced.components.schemas.Narrative.type).toBe("object");
  });

  it("check passes on an in-sync file and fails on drift", () => {
    const out = tmpFile("checked.yaml");
    run(["generate", "Patient", "--fhir-version", "r4", "-o", out]);

    const inSync = run(["check", "Patient", "--fhir-version", "r4", "--file", out]);
    expect(inSync.code).toBe(0);

    // Same file no longer covers Observation -> drift.
    const drift = run(
      ["check", "Patient", "Observation", "--fhir-version", "r4", "--file", out],
      true,
    );
    expect(drift.code).toBe(1);
  });

  it("generate --no-enums strips binding enums", () => {
    const { stdout } = run(["generate", "Patient", "--fhir-version", "r4", "--no-enums"]);
    const doc = parse(stdout);
    expect(doc.components.schemas.Patient.properties.gender.enum).toBeUndefined();
    expect(doc.components.schemas.Patient.properties.resourceType.enum).toEqual(["Patient"]);
  });

  it("lists resources", () => {
    const { stdout } = run(["list", "--fhir-version", "r4b"]);
    expect(stdout.split("\n")).toContain("Patient");
  });

  it("rejects unknown resources with a helpful error", () => {
    const { code } = run(["generate", "Nope", "--fhir-version", "r4"], true);
    expect(code).toBe(1);
  });
});
