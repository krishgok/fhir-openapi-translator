#!/usr/bin/env node
import { Command, Option } from "commander";
import fs from "node:fs";
import { generateOpenApi, listResources } from "./generate.js";
import { MergeConflictError, mergeIntoYaml, stringifyDocument } from "./merge.js";
import type { FhirVersion, OpenApiVersion, SourceBackend } from "./types.js";

const program = new Command();

program
  .name("fhir-oas")
  .description(
    "Generate OpenAPI specifications for HL7 FHIR resources, for model codegen in any language.",
  );

const fhirVersionOption = new Option("-f, --fhir-version <version>", "FHIR version")
  .choices(["r4", "r4b", "r5"])
  .makeOptionMandatory();

const sourceOption = new Option(
  "-s, --source <backend>",
  "definition source backend",
)
  .choices(["schema-json", "structure-def"])
  .default("schema-json");

program
  .command("generate")
  .description("Generate an OpenAPI spec for one or more FHIR resources")
  .argument("<resources...>", 'FHIR resource names, e.g. "Patient Observation"')
  .addOption(fhirVersionOption)
  .addOption(
    new Option("--openapi-version <version>", "target OpenAPI version")
      .choices(["3.0", "3.0.3", "3.1", "3.1.0"])
      .default("3.0.3"),
  )
  .addOption(sourceOption)
  .option("-o, --output <file>", "write a new spec file (YAML unless --format json)")
  .option("--merge-into <file>", "merge into an existing YAML spec file")
  .option("--force", "overwrite conflicting entries when merging", false)
  .addOption(
    new Option("--format <format>", "output format for --output/stdout")
      .choices(["yaml", "json"])
      .default("yaml"),
  )
  .option("--base-url <url>", "server base URL to embed in the spec")
  .option("--title <title>", "override the generated info.title")
  .option("--exclude-narrative", "replace the Narrative type with a generic object", false)
  .option(
    "--max-depth <n>",
    "stub schema definitions deeper than n hops from the requested resources",
    (value) => Number.parseInt(value, 10),
  )
  .action((resources: string[], opts) => {
    try {
      if (opts.output && opts.mergeInto) {
        throw new Error("Use either --output or --merge-into, not both");
      }
      if (opts.maxDepth !== undefined && (!Number.isInteger(opts.maxDepth) || opts.maxDepth < 0)) {
        throw new Error("--max-depth must be a non-negative integer");
      }
      const openApiVersion: OpenApiVersion = opts.openapiVersion.startsWith("3.1")
        ? "3.1.0"
        : "3.0.3";

      const document = generateOpenApi({
        resources,
        fhirVersion: opts.fhirVersion as FhirVersion,
        openApiVersion,
        source: opts.source as SourceBackend,
        baseUrl: opts.baseUrl,
        title: opts.title,
        trim: {
          excludeNarrative: opts.excludeNarrative,
          maxDepth: opts.maxDepth,
        },
      });

      if (opts.mergeInto) {
        const existing = fs.existsSync(opts.mergeInto)
          ? fs.readFileSync(opts.mergeInto, "utf8")
          : "";
        const merged = mergeIntoYaml(document, existing, { force: opts.force });
        fs.writeFileSync(opts.mergeInto, merged);
        console.error(`Merged into ${opts.mergeInto}`);
        return;
      }

      const text =
        opts.format === "json"
          ? JSON.stringify(document, null, 2) + "\n"
          : stringifyDocument(document);
      if (opts.output) {
        fs.writeFileSync(opts.output, text);
        console.error(`Wrote ${opts.output}`);
      } else {
        process.stdout.write(text);
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command("list")
  .description("List the FHIR resource types available for a FHIR version")
  .addOption(fhirVersionOption)
  .addOption(sourceOption)
  .action((opts) => {
    try {
      for (const name of listResources(opts.fhirVersion as FhirVersion, opts.source)) {
        console.log(name);
      }
    } catch (error) {
      fail(error);
    }
  });

function fail(error: unknown): never {
  if (error instanceof MergeConflictError) {
    console.error(error.message);
  } else {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}

program.parse();
