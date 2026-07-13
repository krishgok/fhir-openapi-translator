#!/usr/bin/env node
/**
 * Refreshes the vendored FHIR definition artifacts in ./definitions.
 *
 * Sources (all fetched through the npm registry, which mirrors the official
 * HL7 build artifacts):
 *   - r4:  @medplum/definitions  (official 4.0.1 artifacts under dist/fhir/r4)
 *   - r4b: hl7.fhir.r4b.core@4.3.0
 *   - r5:  hl7.fhir.r5.core@5.0.0
 *
 * Produces, per FHIR version:
 *   definitions/<ver>/fhir.schema.json.gz          official JSON Schema
 *   definitions/<ver>/search-parameters.json.gz    Bundle of SearchParameter
 *   definitions/<ver>/structure-definitions.json.gz  minimized snapshots
 */
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const OUT = path.join(ROOT, "definitions");

const SOURCES = {
  r4: { pkg: "@medplum/definitions@5.1.26", layout: "medplum" },
  r4b: { pkg: "hl7.fhir.r4b.core@4.3.0", layout: "fhir-core" },
  r5: { pkg: "hl7.fhir.r5.core@5.0.0", layout: "fhir-core" },
};

function minimizeStructureDefinition(sd) {
  return {
    name: sd.name,
    url: sd.url,
    kind: sd.kind,
    type: sd.type,
    abstract: sd.abstract,
    baseDefinition: sd.baseDefinition,
    elements: (sd.snapshot?.element ?? []).map((el) => {
      const out = { path: el.path, min: el.min, max: el.max };
      if (el.short) out.short = el.short;
      if (el.definition) out.definition = el.definition;
      if (el.contentReference) out.contentReference = el.contentReference;
      if (el.type) {
        out.types = el.type.map((t) => {
          const type = { code: t.code };
          if (t.targetProfile) type.targetProfile = t.targetProfile;
          // primitive value representation lives in an extension
          const fhirType = (t.extension ?? []).find(
            (e) =>
              e.url ===
              "http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type",
          );
          if (fhirType?.valueUrl) type.fhirType = fhirType.valueUrl;
          return type;
        });
      }
      if (el.binding?.strength === "required" && el.binding.valueSet) {
        out.binding = { strength: el.binding.strength, valueSet: el.binding.valueSet };
      }
      return out;
    }),
  };
}

function wantStructureDefinition(sd) {
  return (
    sd.resourceType === "StructureDefinition" &&
    sd.derivation !== "constraint" &&
    ["resource", "complex-type", "primitive-type"].includes(sd.kind)
  );
}

function writeGz(file, obj) {
  const gz = gzipSync(Buffer.from(JSON.stringify(obj)), { level: 9 });
  fs.writeFileSync(file, gz);
  console.log(`  ${path.relative(ROOT, file)}  ${(gz.length / 1024).toFixed(0)} KiB`);
}

function collectRefNames(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectRefNames(item, out);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#/definitions/")) {
        out.add(value.slice("#/definitions/".length));
      } else {
        collectRefNames(value, out);
      }
    }
  }
  return out;
}

/**
 * Medplum's fhir.schema.json augments the official R4 schema with ~46
 * Medplum-proprietary resources (AccessPolicy, Project, Bot, ...). Restrict
 * it to the official resource set (taken from the pristine
 * profiles-resources.json) and the definitions reachable from it.
 */
function filterSchemaToResources(schema, officialResources) {
  const official = new Set(officialResources);
  const keep = new Set();
  let frontier = [...official].filter((name) => schema.definitions[name]);
  while (frontier.length > 0) {
    const next = [];
    for (const name of frontier) {
      if (keep.has(name) || !schema.definitions[name]) continue;
      keep.add(name);
      if (name === "ResourceList") continue; // rebuilt below
      for (const dep of collectRefNames(schema.definitions[name], new Set())) {
        if (!keep.has(dep)) next.push(dep);
      }
    }
    frontier = next;
  }

  const definitions = {};
  for (const name of Object.keys(schema.definitions)) {
    if (keep.has(name)) definitions[name] = schema.definitions[name];
  }
  const resourceNames = Object.keys(schema.discriminator.mapping).filter((n) => official.has(n));
  definitions.ResourceList = {
    oneOf: resourceNames.map((n) => ({ $ref: `#/definitions/${n}` })),
  };
  return {
    ...schema,
    discriminator: {
      propertyName: schema.discriminator.propertyName,
      mapping: Object.fromEntries(resourceNames.map((n) => [n, `#/definitions/${n}`])),
    },
    oneOf: resourceNames.map((n) => ({ $ref: `#/definitions/${n}` })),
    definitions,
  };
}

function extractMedplum(dir, outDir) {
  const base = path.join(dir, "package/dist/fhir/r4");

  const sds = [];
  const officialResources = [];
  for (const file of ["profiles-types.json", "profiles-resources.json"]) {
    const bundle = JSON.parse(fs.readFileSync(path.join(base, file), "utf8"));
    for (const entry of bundle.entry ?? []) {
      // Medplum's R4 bundles also carry the R4B SubscriptionStatus (topic-based
      // subscriptions backport, fhirVersion 4.3.0); keep only genuine 4.0.1.
      if (entry.resource.fhirVersion && entry.resource.fhirVersion !== "4.0.1") continue;
      if (wantStructureDefinition(entry.resource)) {
        sds.push(minimizeStructureDefinition(entry.resource));
        if (entry.resource.kind === "resource") officialResources.push(entry.resource.name);
      }
    }
  }
  writeGz(path.join(outDir, "structure-definitions.json.gz"), sds);

  const schema = JSON.parse(fs.readFileSync(path.join(base, "fhir.schema.json"), "utf8"));
  writeGz(
    path.join(outDir, "fhir.schema.json.gz"),
    filterSchemaToResources(schema, officialResources),
  );

  const searchParams = JSON.parse(
    fs.readFileSync(path.join(base, "search-parameters.json"), "utf8"),
  );
  writeGz(path.join(outDir, "search-parameters.json.gz"), searchParams);
}

function extractFhirCore(dir, outDir) {
  const base = path.join(dir, "package");
  const schema = JSON.parse(
    fs.readFileSync(path.join(base, "openapi/fhir.schema.json"), "utf8"),
  );
  writeGz(path.join(outDir, "fhir.schema.json.gz"), schema);

  const entries = [];
  const sds = [];
  // Sorted so the output is identical regardless of platform readdir order.
  for (const file of fs.readdirSync(base).sort()) {
    if (file.startsWith("SearchParameter-") && file.endsWith(".json")) {
      const sp = JSON.parse(fs.readFileSync(path.join(base, file), "utf8"));
      entries.push({ fullUrl: sp.url, resource: sp });
    } else if (file.startsWith("StructureDefinition-") && file.endsWith(".json")) {
      const sd = JSON.parse(fs.readFileSync(path.join(base, file), "utf8"));
      if (wantStructureDefinition(sd)) sds.push(minimizeStructureDefinition(sd));
    }
  }
  writeGz(path.join(outDir, "search-parameters.json.gz"), {
    resourceType: "Bundle",
    type: "collection",
    entry: entries,
  });
  writeGz(path.join(outDir, "structure-definitions.json.gz"), sds);
}

for (const [version, { pkg, layout }] of Object.entries(SOURCES)) {
  console.log(`${version}: ${pkg}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `fhir-defs-${version}-`));
  // npm is npm.cmd on Windows, which can only be spawned through a shell.
  const isWindows = process.platform === "win32";
  const tarball = execFileSync(isWindows ? "npm.cmd" : "npm", [
    "pack", pkg, "--silent", "--pack-destination", tmp,
  ], {
    encoding: "utf8",
    shell: isWindows,
  })
    .trim()
    .split("\n")
    .pop();
  execFileSync("tar", ["-xzf", path.join(tmp, tarball), "-C", tmp]);

  const outDir = path.join(OUT, version);
  fs.mkdirSync(outDir, { recursive: true });
  if (layout === "medplum") extractMedplum(tmp, outDir);
  else extractFhirCore(tmp, outDir);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("done");
